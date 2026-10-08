/* "Perlu diperbaiki" (Ryoma 2026-10-06): what didn't make it into an
   approved offer stays on a list until someone fixes it, so the team knows
   which data needs work without holding up what the client can get now.

   Six kinds, each created by the server at the moment it is known:
   - not_in_catalog: a row of the client's list with no catalog item
     (sent with POST /quotes from "Dari list klien"),
   - cogs_held:      a line held because its catalog COGS needs a manager,
   - unit_unknown:   a line in a unit the catalog has no ratio for,
     (both taken from the items as frozen at submit),
   - sales_rejected: a line sales marked Tolak in the "Cek harga" Excel.

   A task is open until someone with the right permission marks it done
   with a note. The same problem on the same quote line is one open task,
   however often the quote is resubmitted (dedupeKey). */

import type { Permission } from "./permissions.js";
import type { QuoteItem } from "./types.js";
import { uomWarning } from "./uom.js";

export type FixKind = "not_in_catalog" | "cogs_held" | "unit_unknown" | "sales_rejected" | "accurate_check" | "new_item";

export const FIX_KINDS: Record<FixKind, { label: string; todo: string; permission: Permission }> = {
  not_in_catalog: {
    label: "Tidak ada di katalog",
    todo: "Tambahkan item ini ke katalog (atau Accurate), lalu tawarkan susulan ke klien.",
    permission: "edit_catalog",
  },
  cogs_held: {
    label: "COGS perlu dicek",
    todo: "Cek dan verifikasi COGS item ini di katalog, lalu tawarkan susulan ke klien.",
    permission: "edit_catalog",
  },
  unit_unknown: {
    label: "Satuan belum ada rasionya",
    todo: "Isi rasio satuan item ini di katalog, lalu cek ulang harga baris itu.",
    permission: "edit_catalog",
  },
  sales_rejected: {
    label: "Harga ditolak sales",
    todo: "Tinjau harga baris ini sesuai alasan sales, lalu tawarkan susulan ke klien.",
    permission: "decide_quotes",
  },
  // Not tied to a quote: one task per kind of mismatch with Accurate, written
  // and closed by the cross-check (shared/accurateReconcile.ts), so "done" by
  // hand only mutes it until the next check finds it again.
  accurate_check: {
    label: "Cek silang Accurate",
    todo: "Buka Katalog → Sinkron Accurate → Cek silang, periksa selisihnya.",
    permission: "import_catalog",
  },
  // A "barang baru" a manager handed over (shared/pendingItems.ts). Closed by
  // the system once the catalog has the code, or when the request is cancelled.
  new_item: {
    label: "Barang baru ke Accurate",
    todo: "Buat barang ini di Accurate dengan kode yang tertera, lalu sinkron dan Terapkan ke katalog.",
    permission: "edit_catalog",
  },
};

export const isFixKind = (k: string): k is FixKind => k in FIX_KINDS;

export interface NewFixTask {
  kind: FixKind;
  quote_id: number;
  line_id: string | null;
  code: string;
  item_name: string;
  qty: number;
  uom: string;
  detail: string;
}

const norm = (s: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** One open task per problem per quote line (or, for list rows, per item name). */
export function dedupeKey(t: Pick<NewFixTask, "kind" | "quote_id" | "line_id" | "item_name">): string {
  return `${t.kind}|${t.quote_id}|${t.line_id ?? `name:${norm(t.item_name)}`}`;
}

/** The detail a COGS problem gets when no specific text is known. */
export const COGS_HELD_DETAIL = "COGS di katalog perlu dicek manajer.";

/**
 * Tasks for lines of a quote as it was submitted: held for COGS, and lines
 * whose unit has no ratio. `problems` is the catalog's COGS problem per code.
 */
export function tasksFromItems(quoteId: number, items: QuoteItem[], problems: Map<string, string> = new Map()): NewFixTask[] {
  const out: NewFixTask[] = [];
  for (const it of items) {
    const base = { quote_id: quoteId, line_id: it.id, code: it.code ?? "", item_name: it.name, qty: Number(it.qty) || 0, uom: it.uom ?? "" };
    if (it.held && (!it.holdReason || it.holdReason === "cogs")) {
      out.push({ ...base, kind: "cogs_held", detail: (it.code && problems.get(it.code)) || COGS_HELD_DETAIL });
    }
    const unit = uomWarning(it);
    if (unit) out.push({ ...base, kind: "unit_unknown", detail: unit });
  }
  return out;
}

export interface UnmatchedRow {
  name: string;
  qty: number;
  uom: string;
  /** "none": nothing in the catalog matched; "skipped": the person left it out. */
  reason: "none" | "skipped";
}

export function tasksFromUnmatched(quoteId: number, rows: UnmatchedRow[]): NewFixTask[] {
  return rows
    .filter((r) => norm(r.name))
    .map((r) => ({
      kind: "not_in_catalog" as const,
      quote_id: quoteId,
      line_id: null,
      code: "",
      item_name: r.name.trim(),
      qty: Number(r.qty) || 0,
      uom: (r.uom ?? "").trim(),
      detail:
        r.reason === "none"
          ? "Diminta klien, tidak ditemukan di katalog."
          : "Diminta klien, tidak dipakai saat membuat quotation (kecocokan katalog tidak tepat).",
    }));
}

export function tasksFromSalesRejection(
  quoteId: number,
  rejected: { id: string; reason: string }[],
  items: QuoteItem[],
  reviewer: string,
): NewFixTask[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  return rejected.flatMap((r) => {
    const it = byId.get(r.id);
    if (!it) return [];
    return [{
      kind: "sales_rejected" as const,
      quote_id: quoteId,
      line_id: it.id,
      code: it.code ?? "",
      item_name: it.name,
      qty: Number(it.qty) || 0,
      uom: it.uom ?? "",
      detail: `Ditolak ${reviewer}: ${r.reason}`,
    }];
  });
}

/* ---------------- daily reminder ---------------- */

export interface OpenTaskRow {
  id: number;
  kind: FixKind;
  item_name: string;
  qty: number;
  uom: string;
  detail: string;
  created_at: string;
  quote_number: string | null;
  client_name: string | null;
}

/** Whole days between an SQLite UTC timestamp and `now`. */
export function ageDays(createdAt: string, now: Date): number {
  const t = Date.parse(createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : 0;
}

const esc = (s: string) =>
  (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The morning email: every open task, oldest first, grouped by kind.
 * Null when nothing is open (no email is sent).
 */
export function digestEmail(tasks: OpenTaskRow[], now: Date, link: string): { subject: string; html: string } | null {
  if (!tasks.length) return null;
  const sorted = [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const oldest = ageDays(sorted[0].created_at, now);
  const subject = `Perlu diperbaiki: ${tasks.length} item terbuka` + (oldest ? ` (tertua ${oldest} hari)` : "");
  const sections = (Object.keys(FIX_KINDS) as FixKind[])
    .map((kind) => {
      const rows = sorted.filter((t) => t.kind === kind);
      if (!rows.length) return "";
      const lis = rows
        .map((t) => {
          const where = [t.quote_number, t.client_name].filter(Boolean).join(" · ");
          const qty = t.qty ? ` (${t.qty} ${t.uom})`.replace(/ \)$/, ")") : "";
          return `<li><strong>${esc(t.item_name)}</strong>${esc(qty)}${where ? ` — ${esc(where)}` : ""}` +
            ` — ${ageDays(t.created_at, now)} hari<br><small>${esc(t.detail)}</small></li>`;
        })
        .join("");
      return `<h3>${esc(FIX_KINDS[kind].label)} (${rows.length})</h3><p><small>${esc(FIX_KINDS[kind].todo)}</small></p><ul>${lis}</ul>`;
    })
    .join("");
  const html =
    `<p>Ada ${tasks.length} item yang belum diperbaiki. Penawaran ke klien tetap jalan tanpa item ini; ` +
    `item ini perlu dibereskan supaya bisa ditawarkan susulan.</p>${sections}` +
    `<p><a href="${esc(link)}">Buka daftar Perlu diperbaiki</a></p>`;
  return { subject, html };
}
