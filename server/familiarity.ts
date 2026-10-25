/* ============================================================
   Interactive familiarity — the logic the Worker routes run.

   POST   /api/familiarity/feed
   GET    /api/familiarity/sessions/:sessionId
   PATCH  /api/familiarity/sessions/:sessionId/resolve

   The route file only translates HTTP (Hono) and calls the functions
   here. The D1 budget rules are
   part of the design:

   - a feed loads the catalog once and keeps a candidate snapshot per row;
   - reading a session refreshes only the candidate ids it stored, with
     WHERE IN, instead of re-scoring against the whole catalog;
   - the status figure is one aggregate row, not a row scan in JS.
   ============================================================ */

import { z } from "zod";
import { hasPermission } from "../shared/permissions.js";
import {
  MATCH_SCORE,
  REVIEW_SCORE,
  buildIndex,
  matchLines,
  normalizeText,
  similarity,
  tokens,
  type MatchStatus,
  type RequestLine,
} from "../shared/match.js";
import { normalizeCode } from "../shared/duplicates.js";
import type { Rejected } from "../shared/matchLearning.js";
import { INSERT_FEEDBACK_SQL, REJECTED_SQL, rejectedMap } from "./matchLearning.js";
import {
  candidateKey,
  emptySummary,
  rowStatus,
  type FamiliarityAction,
  type FamiliarityCandidate,
  type FamiliarityRow,
  type FamiliaritySessionView,
  type FamiliaritySummary,
} from "../shared/familiarity.js";
import { cleanInputLine, splitLeadingCode, type FamiliarityInputLine } from "../shared/familiarityParse.js";
import type { CatalogItem, Role } from "../shared/types.js";
import { INSERT_PENDING_SQL, pendingItemSchema } from "./pendingItems.js";

/* ---------------- storage contract ---------------- */

export type FamiliarityParam = string | number | null;

/** The database calls the service needs: async, as D1 (and the node:sqlite shim in tests) provide them. */
export interface FamiliarityStore {
  all<T = Record<string, unknown>>(sql: string, ...params: FamiliarityParam[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: FamiliarityParam[]): Promise<T | undefined>;
  run(sql: string, ...params: FamiliarityParam[]): Promise<{ changes: number; lastId: number }>;
}

export interface FamiliarityActor {
  id: number;
  role: Role;
}

export class FamiliarityError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/* ---------------- HTTP input ---------------- */

export const feedInputSchema = z.object({
  client_id: z.union([z.string(), z.number(), z.null()]).optional(),
  title: z.string().trim().max(200).optional(),
  raw_lines: z
    .array(
      z.object({
        text: z.string().trim().min(1, "Teks baris wajib diisi.").max(3000),
        qty: z.number().finite().nonnegative().optional(),
        unit: z.string().trim().max(32).optional(),
        code: z.string().trim().max(64).optional(),
      }),
    )
    .max(2000)
    .optional(),
});

export const resolveInputSchema = z.object({
  row_id: z.number().int().positive(),
  action: z.enum(["verify_item", "create_new_item", "ignore_row", "reject_candidate"]),
  item_id: z.string().trim().min(1).max(64).optional(),
  new_item_payload: pendingItemSchema.optional(),
  /** Default: remember the wording for this client only. */
  apply_to_client_only: z.boolean().default(true),
});

export type ResolveInput = z.infer<typeof resolveInputSchema>;

/* ---------------- stored rows ---------------- */

interface SessionRow {
  id: number;
  client_id: number | null;
  title: string;
  source: string;
  created_by: number | null;
}

interface StoredRow {
  id: number;
  session_id: number;
  line_no: number;
  raw_text: string;
  normalized_raw_text: string;
  qty: number;
  unit: string;
  match_status: MatchStatus;
  match_via: string;
  match_score: number;
  candidates_json: string;
  resolved_action: FamiliarityAction | null;
  resolved_item_id: string | null;
  resolved_item_code: string;
  resolved_item_name: string;
  resolved_pending_item_id: number | null;
  resolved_by: number | null;
  resolved_at: string | null;
}

interface RuleRow {
  id: number;
  client_id: number;
  session_id: number;
  normalized_raw_text: string;
  action: FamiliarityAction;
  item_id: string | null;
  item_code: string;
  item_name: string;
  pending_item_id: number | null;
  created_by: number | null;
}

interface PendingRow {
  id: number;
  code: string;
  name: string;
  uom: string;
  proposed_price: number;
  note: string;
  status: string;
}

interface MatcherItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  pendingId?: number;
}

const ROW_COLUMNS = `id, session_id, line_no, raw_text, normalized_raw_text, qty, unit,
  match_status, match_via, match_score, candidates_json, resolved_action, resolved_item_id,
  resolved_item_code, resolved_item_name, resolved_pending_item_id, resolved_by, resolved_at`;

const SESSION_COLUMNS = "id, client_id, title, source, created_by";

const SUMMARY_SQL = `
  SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS resolved,
         COALESCE(SUM(CASE WHEN resolved_at IS NULL AND match_status IN ('exact', 'match') THEN 1 ELSE 0 END), 0) AS pasti,
         COALESCE(SUM(CASE WHEN resolved_at IS NULL AND match_status = 'review' THEN 1 ELSE 0 END), 0) AS mirip,
         COALESCE(SUM(CASE WHEN resolved_at IS NULL AND match_status NOT IN ('exact', 'match', 'review') THEN 1 ELSE 0 END), 0) AS adjustment
    FROM familiarity_session_rows WHERE session_id = ?`;

const RULE_LOOKUP_SQL = `
  SELECT id, client_id, session_id, normalized_raw_text, action, item_id, item_code, item_name,
         pending_item_id, created_by
    FROM familiarity_rules
   WHERE (client_id = ? AND client_id <> 0) OR (client_id = 0 AND session_id = 0)
   ORDER BY client_id DESC, id DESC`;

const RULE_UPSERT_SQL = `
  INSERT INTO familiarity_rules(client_id, session_id, normalized_raw_text, action, item_id, item_code,
                                item_name, pending_item_id, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(client_id, session_id, normalized_raw_text) DO UPDATE SET
    action = excluded.action, item_id = excluded.item_id, item_code = excluded.item_code,
    item_name = excluded.item_name, pending_item_id = excluded.pending_item_id,
    created_by = excluded.created_by, updated_at = datetime('now')`;

const INSERT_ROWS_SQL = `
  INSERT INTO familiarity_session_rows(
    session_id, line_no, raw_text, normalized_raw_text, qty, unit,
    match_status, match_via, match_score, candidates_json,
    resolved_action, resolved_item_id, resolved_item_code, resolved_item_name,
    resolved_pending_item_id, resolved_by, resolved_at)
  SELECT ?, json_extract(j.value, '$.line_no'), json_extract(j.value, '$.raw_text'),
         json_extract(j.value, '$.normalized_raw_text'), json_extract(j.value, '$.qty'),
         json_extract(j.value, '$.unit'), json_extract(j.value, '$.match_status'),
         json_extract(j.value, '$.match_via'), json_extract(j.value, '$.match_score'),
         json_extract(j.value, '$.candidates_json'), json_extract(j.value, '$.resolved_action'),
         json_extract(j.value, '$.resolved_item_id'), json_extract(j.value, '$.resolved_item_code'),
         json_extract(j.value, '$.resolved_item_name'), json_extract(j.value, '$.resolved_pending_item_id'),
         json_extract(j.value, '$.resolved_by'),
         CASE WHEN json_extract(j.value, '$.resolved') = 1 THEN datetime('now') ELSE NULL END
    FROM json_each(?) j`;

const RESOLVE_ROWS_SQL = `
  UPDATE familiarity_session_rows
     SET resolved_action = ?, resolved_item_id = ?, resolved_item_code = ?, resolved_item_name = ?,
         resolved_pending_item_id = ?, resolved_by = ?, resolved_at = datetime('now')
   WHERE session_id = ? AND normalized_raw_text = ?`;

/* ---------------- helpers ---------------- */

const num = (v: unknown): number => Number(v) || 0;

function summaryFromDb(row: Record<string, unknown> | undefined): FamiliaritySummary {
  if (!row) return emptySummary();
  return {
    total: num(row.total),
    pasti: num(row.pasti),
    mirip: num(row.mirip),
    adjustment: num(row.adjustment),
    resolved: num(row.resolved),
  };
}

function candidateOf(
  id: number,
  score: number,
  catalog: Map<number, CatalogItem>,
  pending: Map<number, PendingRow>,
): FamiliarityCandidate | null {
  if (id < 0) {
    const p = pending.get(-id);
    if (!p) return null;
    return { source: "pending", item_id: null, pending_item_id: p.id, code: p.code, name: p.name, uom: p.uom, score };
  }
  const c = catalog.get(id);
  if (!c) return null;
  return { source: "catalog", item_id: String(c.id), pending_item_id: null, code: c.code, name: c.name, uom: c.uom, score };
}

function ruleCandidate(rule: RuleRow, catalog: Map<number, CatalogItem>, pending: Map<number, PendingRow>): FamiliarityCandidate | null {
  if (rule.action === "verify_item" && rule.item_id) {
    const item = catalog.get(Number(rule.item_id));
    if (item) return { source: "catalog", item_id: String(item.id), pending_item_id: null, code: item.code, name: item.name, uom: item.uom, score: 1 };
    return { source: "catalog", item_id: rule.item_id, pending_item_id: null, code: rule.item_code, name: rule.item_name, uom: "", score: 1 };
  }
  if (rule.action === "create_new_item" && rule.pending_item_id) {
    const p = pending.get(rule.pending_item_id);
    if (p) return { source: "pending", item_id: null, pending_item_id: p.id, code: p.code, name: p.name, uom: p.uom, score: 1 };
    return { source: "pending", item_id: null, pending_item_id: rule.pending_item_id, code: rule.item_code, name: rule.item_name, uom: "", score: 1 };
  }
  return null;
}

function parseCandidates(raw: string): FamiliarityCandidate[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FamiliarityCandidate[]) : [];
  } catch {
    return [];
  }
}

function resolvedOf(row: StoredRow) {
  if (!row.resolved_at || !row.resolved_action) return null;
  return {
    action: row.resolved_action,
    item_id: row.resolved_item_id,
    pending_item_id: row.resolved_pending_item_id,
    code: row.resolved_item_code || null,
    name: row.resolved_item_name,
    normalized_raw_text: row.normalized_raw_text,
  };
}

function viewOf(row: StoredRow): FamiliarityRow {
  const candidates = parseCandidates(row.candidates_json);
  const resolved = resolvedOf(row);
  // The chosen item may not have been among the matcher's five candidates.
  if (resolved && resolved.action !== "ignore_row") {
    const source = resolved.pending_item_id ? "pending" : "catalog";
    const key = source === "catalog" ? `catalog:${resolved.item_id}` : `pending:${resolved.pending_item_id}`;
    if (!candidates.some((c) => candidateKey(c) === key)) {
      candidates.unshift({
        source,
        item_id: resolved.item_id,
        pending_item_id: resolved.pending_item_id,
        code: resolved.code ?? "",
        name: resolved.name,
        uom: "",
        score: 1,
      });
    }
  }
  const top = candidates[0];
  return {
    id: row.id,
    line_no: row.line_no,
    raw_text: row.raw_text,
    normalized_raw_text: row.normalized_raw_text,
    qty: Number(row.qty),
    unit: row.unit,
    status: rowStatus(row),
    match: {
      status: row.match_status,
      via: (row.match_via || null) as FamiliarityRow["match"]["via"],
      score: Number(row.match_score),
      item_id: top?.source === "catalog" ? top.item_id : null,
      pending_item_id: top?.source === "pending" ? top.pending_item_id : null,
    },
    candidates,
    resolved,
  };
}

/** Refresh candidate/resolved names from the live catalog and pending requests. */
async function enrichRows(store: FamiliarityStore, rows: StoredRow[]): Promise<FamiliarityRow[]> {
  const catalogIds = new Set<number>();
  const pendingIds = new Set<number>();
  for (const row of rows) {
    for (const c of parseCandidates(row.candidates_json)) {
      if (c.source === "catalog" && c.item_id) catalogIds.add(Number(c.item_id));
      if (c.source === "pending" && c.pending_item_id) pendingIds.add(c.pending_item_id);
    }
    if (row.resolved_item_id) catalogIds.add(Number(row.resolved_item_id));
    if (row.resolved_pending_item_id) pendingIds.add(row.resolved_pending_item_id);
  }

  const catalog = new Map<number, CatalogItem>();
  const pending = new Map<number, PendingRow>();
  const chunk = <T,>(xs: T[], n = 90): T[][] => { // D1 binds at most 100 params per query
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
    return out;
  };
  for (const ids of chunk([...catalogIds])) {
    const found = await store.all<CatalogItem>(
      `SELECT id, code, name, uom, list_price, stock, category FROM catalog_items WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    for (const c of found) catalog.set(c.id, c);
  }
  for (const ids of chunk([...pendingIds])) {
    const found = await store.all<PendingRow>(
      `SELECT id, code, name, uom, proposed_price, note, status FROM pending_items WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    for (const p of found) pending.set(p.id, p);
  }

  return rows.map((row) => {
    const refreshed = parseCandidates(row.candidates_json).map((c) => {
      if (c.source === "catalog" && c.item_id) {
        const item = catalog.get(Number(c.item_id));
        return item ? { ...c, code: item.code, name: item.name, uom: item.uom } : c;
      }
      if (c.source === "pending" && c.pending_item_id) {
        const p = pending.get(c.pending_item_id);
        return p ? { ...c, code: p.code, name: p.name, uom: p.uom } : c;
      }
      return c;
    });
    let next: StoredRow = { ...row, candidates_json: JSON.stringify(refreshed) };
    if (next.resolved_item_id) {
      const item = catalog.get(Number(next.resolved_item_id));
      if (item) next = { ...next, resolved_item_code: item.code, resolved_item_name: item.name };
    }
    if (next.resolved_pending_item_id) {
      const p = pending.get(next.resolved_pending_item_id);
      if (p) next = { ...next, resolved_item_code: p.code, resolved_item_name: p.name };
    }
    return viewOf(next);
  });
}

async function rowsOf(store: FamiliarityStore, sql: string, ...params: FamiliarityParam[]): Promise<StoredRow[]> {
  return store.all<StoredRow>(sql, ...params);
}

async function summaryOfSession(store: FamiliarityStore, sessionId: number): Promise<FamiliaritySummary> {
  return summaryFromDb(await store.get<Record<string, unknown>>(SUMMARY_SQL, sessionId));
}

/* ---------------- feed ---------------- */

export async function createFamiliaritySession(
  store: FamiliarityStore,
  input: { clientId: number | null; title: string; source: string; lines: FamiliarityInputLine[] },
  actor: FamiliarityActor,
): Promise<FamiliaritySessionView> {
  // Raw text and file rows go through the same cleaner: collapse spacing,
  // drop a pasted list number ("1. Pensil"), clamp qty/unit/code. A row that
  // cleans to nothing (a stray "2.") is not a line.
  const lines = input.lines.map((l) => cleanInputLine(l)).filter((l) => l.text);
  if (!lines.length) throw new FamiliarityError(400, "Tidak ada baris yang bisa diproses.");
  if (lines.length > 2000) throw new FamiliarityError(400, "Maksimal 2000 baris per sesi.");

  const catalog = await store.all<CatalogItem>(
    "SELECT id, code, name, uom, list_price, stock, category FROM catalog_items ORDER BY id",
  );
  const pending = await store.all<PendingRow>(
    `SELECT id, code, name, uom, proposed_price, note, status FROM pending_items
      WHERE status IN ('draft', 'submitted') ORDER BY id DESC LIMIT 2000`,
  );
  const rules = await store.all<RuleRow>(RULE_LOOKUP_SQL, input.clientId ?? 0);
  const rejected: Rejected = rejectedMap(await store.all<{ text: string; suggested: string }>(REJECTED_SQL));

  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const pendingById = new Map(pending.map((p) => [p.id, p]));
  const matcherItems: MatcherItem[] = [
    ...catalog.map((c) => ({ id: c.id, code: c.code, name: c.name, uom: c.uom })),
    ...pending.map((p) => ({ id: -p.id, code: p.code, name: p.name, uom: p.uom, pendingId: p.id })),
  ];
  const index = buildIndex(matcherItems);

  // A rule is client-specific where there is a client, else global. The query
  // already excludes no-client session-only rules from other sessions.
  const clientRule = new Map<string, RuleRow>();
  const globalRule = new Map<string, RuleRow>();
  for (const r of rules) {
    const map = r.client_id !== 0 ? clientRule : globalRule;
    if (!map.has(r.normalized_raw_text)) map.set(r.normalized_raw_text, r);
  }

  const knownCode = (code: string) => index.byCode.has(normalizeCode(code));

  const prepared = lines.map((line) => {
    const rawText = line.text;
    const normalized = normalizeText(rawText);
    // A line that is only a known code belongs to that item; otherwise split
    // the code the client glued to the name ("100591 CAFE_GARAM 1 KG").
    let matchLine: FamiliarityInputLine =
      !line.code && !/\s/.test(line.text) && knownCode(line.text)
        ? { ...line, code: line.text }
        : splitLeadingCode(line, knownCode);
    return { rawText, normalized, line: matchLine, rule: clientRule.get(normalized) ?? globalRule.get(normalized) };
  });

  const requests: RequestLine[] = prepared.map(({ line }) => ({
    code: line.code,
    name: line.text,
    uom: line.unit,
    qty: line.qty ?? 1,
  }));
  const matches = matchLines(requests, matcherItems, undefined, rejected);

  const payload = prepared.map(({ rawText, normalized, line, rule }, i) => {
    const result = matches[i];
    const candidates: FamiliarityCandidate[] = [];
    const seen = new Set<string>();
    for (const c of result.candidates) {
      const candidate = candidateOf(c.id, c.score, catalogById, pendingById);
      if (!candidate) continue;
      const key = candidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
    if (rule) {
      const chosen = ruleCandidate(rule, catalogById, pendingById);
      if (chosen) {
        const key = candidateKey(chosen);
        const at = candidates.findIndex((c) => candidateKey(c) === key);
        if (at >= 0) candidates.splice(at, 1);
        candidates.unshift(chosen);
      }
    }

    const top = result.candidates[0];
    const resolved = !!rule && rule.action !== "reject_candidate";
    return {
      line_no: i + 1,
      raw_text: rawText,
      normalized_raw_text: normalized,
      qty: line.qty ?? 1,
      unit: line.unit ?? "",
      match_status: result.status,
      match_via: result.via ?? "",
      match_score: top?.score ?? 0,
      candidates_json: JSON.stringify(candidates),
      resolved_action: resolved ? rule!.action : null,
      resolved_item_id: resolved && rule!.action === "verify_item" ? rule!.item_id : null,
      resolved_item_code: resolved ? rule!.item_code : "",
      resolved_item_name: resolved ? rule!.item_name : "",
      resolved_pending_item_id: resolved && rule!.action === "create_new_item" ? rule!.pending_item_id : null,
      resolved_by: resolved ? rule!.created_by : null,
      resolved: resolved ? 1 : 0,
    };
  });

  const inserted = await store.run(
    `INSERT INTO familiarity_sessions(client_id, title, source, created_by) VALUES(?, ?, ?, ?)`,
    input.clientId,
    input.title,
    input.source,
    actor.id,
  );
  const sessionId = inserted.lastId;
  await store.run(INSERT_ROWS_SQL, sessionId, JSON.stringify(payload));

  const rows = await rowsOf(store, `SELECT ${ROW_COLUMNS} FROM familiarity_session_rows WHERE session_id = ? ORDER BY line_no, id`, sessionId);
  const view = await enrichRows(store, rows);
  return { session_id: sessionId, summary: await summaryOfSession(store, sessionId), rows: view };
}

/* ---------------- read ---------------- */

/** Same rule as list drafts: the creator, or whoever may edit every quote. Others see "not found". */
const mayOpenSession = (session: SessionRow, actor: FamiliarityActor) =>
  session.created_by === actor.id || hasPermission(actor.role, "edit_all_quotes");

export async function readFamiliaritySession(
  store: FamiliarityStore,
  sessionId: number,
  actor: FamiliarityActor,
): Promise<FamiliaritySessionView | null> {
  const session = await store.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM familiarity_sessions WHERE id = ?`, sessionId);
  if (!session || !mayOpenSession(session, actor)) return null;
  const rows = await rowsOf(store, `SELECT ${ROW_COLUMNS} FROM familiarity_session_rows WHERE session_id = ? ORDER BY line_no, id`, sessionId);
  return { session_id: session.id, summary: await summaryOfSession(store, sessionId), rows: await enrichRows(store, rows) };
}

/* ---------------- resolve ---------------- */

async function findSimilarPending(store: FamiliarityStore, payload: z.infer<typeof pendingItemSchema>): Promise<PendingRow | undefined> {
  const live = await store.all<PendingRow>(
    `SELECT id, code, name, uom, proposed_price, note, status FROM pending_items
      WHERE status IN ('draft', 'submitted') ORDER BY id DESC LIMIT 500`,
  );
  const wantedCode = payload.code ? normalizeCode(payload.code) : "";
  const wantedName = normalizeText(payload.name);
  const wantedTokens = tokens(payload.name);
  for (const p of live) {
    if (wantedCode && normalizeCode(p.code) === wantedCode) return p;
    if (normalizeText(p.name) === wantedName) return p;
    if (similarity(wantedTokens, tokens(p.name)) >= MATCH_SCORE) return p;
  }
  return undefined;
}

function statusAfterReject(candidates: FamiliarityCandidate[]): MatchStatus {
  const score = candidates[0]?.score ?? 0;
  if (score >= MATCH_SCORE) return "match";
  if (score >= REVIEW_SCORE) return "review";
  return "none";
}

export async function resolveFamiliarityRow(
  store: FamiliarityStore,
  sessionId: number,
  input: ResolveInput,
  actor: FamiliarityActor,
): Promise<{ session_id: number; summary: FamiliaritySummary; rows: FamiliarityRow[] }> {
  const session = await store.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM familiarity_sessions WHERE id = ?`, sessionId);
  if (!session || !mayOpenSession(session, actor)) throw new FamiliarityError(404, "Sesi familiarity tidak ditemukan.");
  const row = await store.get<StoredRow>(`SELECT ${ROW_COLUMNS} FROM familiarity_session_rows WHERE id = ?`, input.row_id);
  if (!row || row.session_id !== sessionId) throw new FamiliarityError(404, "Baris tidak ditemukan di sesi ini.");

  if (input.action === "verify_item" || input.action === "create_new_item" || input.action === "ignore_row") {
    if (!input.apply_to_client_only && !hasPermission(actor.role, "edit_catalog")) {
      throw new FamiliarityError(
        403,
        "Aturan untuk semua klien hanya bisa disimpan manajer. Pilih 'hanya klien ini'.",
      );
    }
  }

  let item: CatalogItem | undefined;
  let pending: PendingRow | undefined;
  const action = input.action;

  if (action === "verify_item") {
    if (!input.item_id) throw new FamiliarityError(400, "item_id wajib diisi untuk verify_item.");
    const itemId = Number(input.item_id);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new FamiliarityError(400, "item_id tidak valid.");
    item = await store.get<CatalogItem>(
      "SELECT id, code, name, uom, list_price, stock, category FROM catalog_items WHERE id = ?",
      itemId,
    );
    if (!item) throw new FamiliarityError(400, "Item katalog tidak ditemukan.");
  }

  if (action === "create_new_item") {
    if (!input.new_item_payload) throw new FamiliarityError(400, "new_item_payload wajib diisi untuk create_new_item.");
    pending = await findSimilarPending(store, input.new_item_payload);
    if (!pending) {
      const p = input.new_item_payload;
      // A blank code is numbered inside the INSERT. Two resolves at once can
      // pick the same number, so the loser retries, as POST /pending-items does.
      let pendingId = 0;
      for (let attempt = 0; !pendingId; attempt++) {
        try {
          pendingId = (await store.run(INSERT_PENDING_SQL, p.code ?? "", p.name, p.uom || "Pcs", p.proposed_price, p.note, actor.id)).lastId;
        } catch (err) {
          if (!String((err as Error).message).includes("UNIQUE")) throw err;
          if (p.code || attempt >= 2) throw new FamiliarityError(409, "Kode itu baru saja dipakai permintaan lain. Coba lagi.");
        }
      }
      pending = await store.get<PendingRow>(
        "SELECT id, code, name, uom, proposed_price, note, status FROM pending_items WHERE id = ?",
        pendingId,
      );
    }
  }

  // A rejection is not a resolution: it only removes one guess and teaches
  // the matcher (match_feedback) not to offer that pairing as a certainty.
  if (action === "reject_candidate") {
    if (!input.item_id) throw new FamiliarityError(400, "item_id wajib diisi untuk reject_candidate.");
    const candidates = parseCandidates(row.candidates_json);
    const wanted = input.item_id;
    const at = candidates.findIndex((c) =>
      wanted.startsWith("pending:")
        ? c.source === "pending" && String(c.pending_item_id) === wanted.slice("pending:".length)
        : c.source === "catalog" && c.item_id === wanted,
    );
    if (at < 0) throw new FamiliarityError(400, "Kandidat itu tidak ada di baris ini.");
    const removed = candidates[at];
    const kept = candidates.filter((_, i) => i !== at);

    const same = await rowsOf(
      store,
      `SELECT ${ROW_COLUMNS} FROM familiarity_session_rows
        WHERE session_id = ? AND normalized_raw_text = ? ORDER BY id`,
      sessionId,
      row.normalized_raw_text,
    );
    for (const r of same) {
      const own = parseCandidates(r.candidates_json).filter((c) => candidateKey(c) !== candidateKey(removed));
      const next = own[0];
      await store.run(
        `UPDATE familiarity_session_rows
            SET candidates_json = ?, match_status = ?, match_via = ?, match_score = ?
          WHERE id = ?`,
        JSON.stringify(own),
        statusAfterReject(own),
        next ? "name" : "",
        next?.score ?? 0,
        r.id,
      );
    }

    await store.run(
      INSERT_FEEDBACK_SQL,
      JSON.stringify([
        {
          client_id: session.client_id ?? 0,
          text: row.normalized_raw_text,
          raw_text: row.raw_text,
          status: row.match_status,
          via: row.match_via,
          suggested: removed.code,
          score: removed.score,
          chosen: kept[0]?.code ?? null,
          outcome: "corrected",
          user_id: actor.id,
        },
      ]),
    );

    const updated = await rowsOf(
      store,
      `SELECT ${ROW_COLUMNS} FROM familiarity_session_rows
        WHERE session_id = ? AND normalized_raw_text = ? ORDER BY id`,
      sessionId,
      row.normalized_raw_text,
    );
    return { session_id: sessionId, summary: await summaryOfSession(store, sessionId), rows: await enrichRows(store, updated) };
  }

  const clientId = input.apply_to_client_only ? (session.client_id ?? 0) : 0;
  // With no client there is nothing to scope to: apply_to_client_only then
  // means "this session only", while false is the manager's global rule.
  const ruleSessionId = input.apply_to_client_only && clientId === 0 ? session.id : 0;
  const resolvedItemId = action === "verify_item" ? String(item!.id) : null;
  const resolvedCode = action === "verify_item" ? item!.code : action === "create_new_item" ? pending!.code : "";
  const resolvedName = action === "verify_item" ? item!.name : action === "create_new_item" ? pending!.name : "";
  const resolvedPendingId = action === "create_new_item" ? pending!.id : null;

  await store.run(
    RULE_UPSERT_SQL,
    clientId,
    ruleSessionId,
    row.normalized_raw_text,
    action,
    resolvedItemId,
    resolvedCode,
    resolvedName,
    resolvedPendingId,
    actor.id,
  );

  await store.run(
    RESOLVE_ROWS_SQL,
    action,
    resolvedItemId,
    resolvedCode,
    resolvedName,
    resolvedPendingId,
    actor.id,
    sessionId,
    row.normalized_raw_text,
  );

  // Learn from what the human chose: the matcher's top guess vs. this action.
  const candidates = parseCandidates(row.candidates_json);
  const suggested = candidates[0]?.code ?? null;
  const chosen = action === "ignore_row" ? null : resolvedCode;
  const outcome =
    action === "create_new_item" ? "new_item" : !chosen ? "dropped" : suggested === chosen ? "accepted" : "corrected";
  await store.run(
    INSERT_FEEDBACK_SQL,
    JSON.stringify([
      {
        client_id: session.client_id ?? 0,
        text: row.normalized_raw_text,
        raw_text: row.raw_text,
        status: row.match_status,
        via: row.match_via,
        suggested,
        score: row.match_score,
        chosen,
        outcome,
        user_id: actor.id,
      },
    ]),
  );

  await store.run(`UPDATE familiarity_sessions SET updated_at = datetime('now') WHERE id = ?`, sessionId);

  const updated = await rowsOf(
    store,
    `SELECT ${ROW_COLUMNS} FROM familiarity_session_rows
      WHERE session_id = ? AND normalized_raw_text = ? ORDER BY id`,
    sessionId,
    row.normalized_raw_text,
  );
  return { session_id: sessionId, summary: await summaryOfSession(store, sessionId), rows: await enrichRows(store, updated) };
}
