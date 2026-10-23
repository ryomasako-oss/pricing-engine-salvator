/* ============================================================
   Draft "Dari list klien" — the logic both backends run
   (shared/listDrafts.ts explains what a draft keeps and why).

   GET    /api/list-drafts            open drafts I made or was sent; managers: all
   GET    /api/list-drafts/users      who a draft can be sent to (any signed-in user)
   POST   /api/list-drafts            save a new draft
   GET    /api/list-drafts/:id        one draft
   PUT    /api/list-drafts/:id        save over it (carries the version it read)
   POST   /api/list-drafts/:id/send   hand it to a PIC
   DELETE /api/list-drafts/:id        cancel it
   POST   /api/quotes { draft_id }    closes it (claimForQuote, in the quote route)

   Who may touch a draft is one rule, checked on every route above and in
   the same UPDATE that writes: its creator, the PIC it was sent to, or
   anyone who may edit every quote (edit_all_quotes). The list is scoped by
   the same rule, so a draft can't be read by id that the list hides.
   ============================================================ */

import { z } from "zod";
import { hasPermission } from "../shared/permissions.js";
import type { Draft, DraftChoice, DraftSummary } from "../shared/listDrafts.js";
import type { RequestLine } from "../shared/match.js";
import type { Role } from "../shared/types.js";
import type { FamiliarityStore } from "./familiarity.js";

export type DraftStore = FamiliarityStore;

export interface DraftActor {
  id: number;
  role: Role;
  name: string;
}

export class DraftError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Same ceiling as the editor (ListToQuote MAX_LINES). */
export const MAX_DRAFT_LINES = 500;

const lineSchema = z.object({
  code: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(300),
  uom: z.string().max(32).optional(),
  qty: z.number().finite().nonnegative().optional(),
  rrp: z.number().finite().nonnegative().optional(),
  noQty: z.boolean().optional(),
});

const pickSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), code: z.string().trim().min(1).max(64) }),
  z.object({
    kind: z.literal("pending"),
    pendingId: z.number().int().positive(),
    code: z.string().trim().min(1).max(64),
    name: z.string().max(300),
    uom: z.string().max(32),
    price: z.number().finite().nonnegative(),
  }),
]);

const choiceSchema = z.object({
  chosen: pickSchema.nullable(),
  confirmed: z.boolean(),
  extra: z.array(z.string().trim().min(1).max(64)).max(20),
});

export const draftInputSchema = z
  .object({
    title: z.string().trim().max(200).default(""),
    client_id: z.number().int().positive().nullable().default(null),
    file_name: z.string().max(200).default(""),
    notes: z.array(z.string().max(500)).max(20).default([]),
    lines: z.array(lineSchema).min(1).max(MAX_DRAFT_LINES),
    choices: z.array(choiceSchema).max(MAX_DRAFT_LINES),
    /** The version this save was made from (update only). */
    version: z.number().int().positive().optional(),
  })
  .refine((d) => d.choices.length === d.lines.length, { message: "Jumlah pilihan harus sama dengan jumlah baris." });

export const sendInputSchema = z.object({
  assigned_to: z.number().int().positive(),
  note: z.string().trim().max(500).default(""),
});

export type DraftInput = z.infer<typeof draftInputSchema>;

const mayEditAll = (a: DraftActor) => (hasPermission(a.role, "edit_all_quotes") ? 1 : 0);

/** The access rule as SQL over list_drafts d; params: actor id, actor id, edit-all flag. */
const ACCESS = "(d.created_by = ? OR d.assigned_to = ? OR ? = 1)";
const accessParams = (a: DraftActor) => [a.id, a.id, mayEditAll(a)];

const SUMMARY_COLUMNS = `d.id, d.title, d.client_id, cl.name AS client_name, d.file_name,
  json_array_length(d.lines) AS rows, d.status, d.created_by, cu.name AS created_by_name,
  d.assigned_to, au.name AS assigned_to_name, d.assign_note, d.assigned_at, d.quote_id, d.version, d.updated_at`;
const FROM = `FROM list_drafts d
  LEFT JOIN clients cl ON cl.id = d.client_id
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN users au ON au.id = d.assigned_to`;

type DraftRow = DraftSummary & { notes: string; lines: string; choices: string };

function parseDraft(r: DraftRow): Draft {
  return {
    ...r,
    rows: Number(r.rows) || 0,
    notes: JSON.parse(r.notes || "[]") as string[],
    lines: JSON.parse(r.lines || "[]") as RequestLine[],
    choices: JSON.parse(r.choices || "[]") as DraftChoice[],
  };
}

async function rawDraft(store: DraftStore, id: number): Promise<DraftRow | undefined> {
  return store.get<DraftRow>(`SELECT ${SUMMARY_COLUMNS}, d.notes, d.lines, d.choices ${FROM} WHERE d.id = ?`, id);
}

const canTouch = (a: DraftActor, d: { created_by: number; assigned_to: number | null }) =>
  d.created_by === a.id || d.assigned_to === a.id || mayEditAll(a) === 1;

/** Why a guarded write changed nothing, as the status and sentence to answer with. */
async function whyNot(store: DraftStore, actor: DraftActor, id: number, version?: number): Promise<DraftError> {
  const d = await rawDraft(store, id);
  if (!d) return new DraftError(404, "Draft tidak ditemukan.");
  if (!canTouch(actor, d)) return new DraftError(403, "Draft ini milik pengguna lain.");
  if (d.status === "done") return new DraftError(409, "Draft ini sudah dijadikan quotation.");
  if (d.status !== "open") return new DraftError(409, "Draft ini sudah dibatalkan.");
  if (version != null && d.version !== version) {
    return new DraftError(409, "Draft ini baru saja diubah orang lain. Buka ulang untuk melihat versi terbaru.");
  }
  return new DraftError(409, "Draft tidak bisa diubah.");
}

async function checkClient(store: DraftStore, clientId: number | null): Promise<void> {
  if (clientId != null && !(await store.get("SELECT id FROM clients WHERE id = ?", clientId))) {
    throw new DraftError(400, "Klien tidak ditemukan.");
  }
}

export async function listDrafts(store: DraftStore, actor: DraftActor): Promise<DraftSummary[]> {
  const rows = await store.all<DraftSummary>(
    `SELECT ${SUMMARY_COLUMNS} ${FROM} WHERE d.status = 'open' AND ${ACCESS} ORDER BY d.updated_at DESC, d.id DESC LIMIT 100`,
    ...accessParams(actor),
  );
  return rows.map((r) => ({ ...r, rows: Number(r.rows) || 0 }));
}

export async function getDraft(store: DraftStore, actor: DraftActor, id: number): Promise<Draft> {
  const d = await rawDraft(store, id);
  if (!d) throw new DraftError(404, "Draft tidak ditemukan.");
  if (!canTouch(actor, d)) throw new DraftError(403, "Draft ini milik pengguna lain.");
  return parseDraft(d);
}

export async function createDraft(store: DraftStore, actor: DraftActor, input: DraftInput): Promise<Draft> {
  await checkClient(store, input.client_id);
  const r = await store.run(
    `INSERT INTO list_drafts(title, client_id, file_name, notes, lines, choices, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    input.title,
    input.client_id,
    input.file_name,
    JSON.stringify(input.notes),
    JSON.stringify(input.lines),
    JSON.stringify(input.choices),
    actor.id,
  );
  return getDraft(store, actor, r.lastId);
}

export async function updateDraft(store: DraftStore, actor: DraftActor, id: number, input: DraftInput): Promise<Draft> {
  if (input.version == null) throw new DraftError(400, "version wajib diisi.");
  await checkClient(store, input.client_id);
  const r = await store.run(
    `UPDATE list_drafts AS d SET title = ?, client_id = ?, file_name = ?, notes = ?, lines = ?, choices = ?,
            version = version + 1, updated_at = datetime('now')
      WHERE d.id = ? AND d.status = 'open' AND d.version = ? AND ${ACCESS}`,
    input.title,
    input.client_id,
    input.file_name,
    JSON.stringify(input.notes),
    JSON.stringify(input.lines),
    JSON.stringify(input.choices),
    id,
    input.version,
    ...accessParams(actor),
  );
  if (!r.changes) throw await whyNot(store, actor, id, input.version);
  return getDraft(store, actor, id);
}

export interface SendResult {
  draft: Draft;
  /** The PIC to notify; null when someone sent it to themselves. */
  recipient: { name: string; email: string; phone: string } | null;
}

export async function sendDraft(
  store: DraftStore,
  actor: DraftActor,
  id: number,
  input: z.infer<typeof sendInputSchema>,
): Promise<SendResult> {
  const target = await store.get<{ id: number; name: string; email: string; phone: string }>(
    "SELECT id, name, email, phone FROM users WHERE id = ? AND active = 1",
    input.assigned_to,
  );
  if (!target) throw new DraftError(400, "PIC tidak ditemukan atau tidak aktif.");
  const r = await store.run(
    `UPDATE list_drafts AS d SET assigned_to = ?, assigned_by = ?, assigned_at = datetime('now'), assign_note = ?,
            version = version + 1, updated_at = datetime('now')
      WHERE d.id = ? AND d.status = 'open' AND ${ACCESS}`,
    target.id,
    actor.id,
    input.note,
    id,
    ...accessParams(actor),
  );
  if (!r.changes) throw await whyNot(store, actor, id);
  return { draft: await getDraft(store, actor, id), recipient: target.id === actor.id ? null : target };
}

/** Only its creator or a manager cancels a draft: a PIC hands it back instead. */
export async function cancelDraft(store: DraftStore, actor: DraftActor, id: number): Promise<void> {
  const r = await store.run(
    `UPDATE list_drafts AS d SET status = 'cancelled', version = version + 1, updated_at = datetime('now')
      WHERE d.id = ? AND d.status = 'open' AND (d.created_by = ? OR ? = 1)`,
    id,
    actor.id,
    mayEditAll(actor),
  );
  if (r.changes) return;
  const err = await whyNot(store, actor, id);
  throw err.status === 409 && (await rawDraft(store, id))?.status === "open"
    ? new DraftError(403, "Hanya pembuat draft atau manajer yang bisa membatalkannya.")
    : err;
}

/**
 * Closes a draft for the quote being created from it, before the quote is
 * written: of two creates from one draft only the first gets past this, the
 * second gets 409. The caller attaches the quote id, or reopens the draft if
 * writing the quote failed.
 */
export async function claimForQuote(store: DraftStore, actor: DraftActor, id: number): Promise<void> {
  const r = await store.run(
    `UPDATE list_drafts AS d SET status = 'done', version = version + 1, updated_at = datetime('now')
      WHERE d.id = ? AND d.status = 'open' AND ${ACCESS}`,
    id,
    ...accessParams(actor),
  );
  if (!r.changes) throw await whyNot(store, actor, id);
}

export const ATTACH_QUOTE_SQL = "UPDATE list_drafts SET quote_id = ? WHERE id = ?";
export const REOPEN_DRAFT_SQL = "UPDATE list_drafts SET status = 'open', updated_at = datetime('now') WHERE id = ? AND quote_id IS NULL";

/** Everyone a draft may be sent to: names only, for any signed-in user. */
export const ASSIGNABLE_USERS_SQL = "SELECT id, name, role FROM users WHERE active = 1 ORDER BY name";
