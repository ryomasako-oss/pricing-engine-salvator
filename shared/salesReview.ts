/* Server-side rules for a sales "Cek harga" import (PE-2). Both backends
   call checkSalesReview, so Express and the Worker refuse the same files
   with the same messages.

   What sales send back is only {id, decision, reason} per line, plus the
   revision and version the file was made from. Prices are not part of it,
   so nothing in the file can change a price. */

export type SalesDecision = "acc" | "tolak";

import type { QuoteItem } from "./types.js";

export interface SalesReviewLine {
  id: string;
  decision: SalesDecision;
  reason: string;
}

export interface SalesReviewPayload {
  rev_no: number;
  version: number;
  lines: SalesReviewLine[];
}

export interface StoredReviewLine extends SalesReviewLine {
  lineNo: number;
  name: string;
}

interface ReviewableQuote {
  status: string;
  rev_no: number;
  version: number;
  items: { id: string; lineNo: number; name: string; held?: boolean }[];
}

export type SalesReviewCheck =
  | { ok: true; lines: StoredReviewLine[]; rejected: StoredReviewLine[] }
  | { ok: false; status: 400 | 409; error: string };

const list = (ls: { lineNo: number }[]) => ls.map((l) => l.lineNo).join(", ");

export function checkSalesReview(quote: ReviewableQuote, p: SalesReviewPayload): SalesReviewCheck {
  if (quote.status !== "approved") {
    return { ok: false, status: 409, error: "Hasil cek sales hanya bisa di-import ke quotation yang sudah disetujui dan belum dikirim." };
  }
  if (p.rev_no !== quote.rev_no || p.version !== quote.version) {
    return {
      ok: false,
      status: 409,
      error: `File ini dibuat dari versi lama quotation (revisi ${p.rev_no}). Quotation sudah berubah; unduh ulang file cek harga dan kirim lagi ke sales.`,
    };
  }
  const offered = quote.items.filter((it) => !it.held);
  const byId = new Map(offered.map((it) => [it.id, it]));
  const seen = new Set<string>();
  for (const l of p.lines) {
    if (!byId.has(l.id) || seen.has(l.id)) {
      return { ok: false, status: 400, error: "Baris di file tidak cocok dengan quotation ini. Unduh ulang file cek harga." };
    }
    seen.add(l.id);
  }
  const missing = offered.filter((it) => !seen.has(it.id));
  if (missing.length) {
    return { ok: false, status: 400, error: `Baris ${list(missing)} belum diisi ACC atau Tolak.` };
  }
  const lines: StoredReviewLine[] = offered.map((it) => {
    const l = p.lines.find((x) => x.id === it.id)!;
    return { id: it.id, lineNo: it.lineNo, name: it.name, decision: l.decision, reason: l.reason.trim() };
  });
  const noReason = lines.filter((l) => l.decision === "tolak" && !l.reason);
  if (noReason.length) {
    return { ok: false, status: 400, error: `Baris ${list(noReason)} ditolak tanpa alasan. Isi kolom Alasan.` };
  }
  return { ok: true, lines, rejected: lines.filter((l) => l.decision === "tolak") };
}

/** The reasons in one line, for the managers' email. */
export function rejectionNote(reviewer: string, rejected: StoredReviewLine[]): string {
  return (
    `Ditolak sales (${reviewer}): ` +
    rejected.map((l) => `baris ${l.lineNo} ${l.name} — ${l.reason}`).join("; ") +
    ". Perbaiki harga baris itu lalu ajukan lagi."
  );
}

/**
 * What a sales check does to the quote (Ryoma 2026-10-06: the client gets
 * what sales accepted without waiting). "none": nothing rejected. "partial":
 * the rejected lines are held as "sales" (left off the document, named as
 * "item menyusul") and the rest stays approved. "all": nothing left to
 * offer, so the quote goes back to draft for the manager.
 */
export function salesOutcome(items: QuoteItem[], rejected: { id: string }[]): {
  mode: "none" | "partial" | "all";
  items: QuoteItem[];
} {
  if (!rejected.length) return { mode: "none", items };
  const ids = new Set(rejected.map((r) => r.id));
  const offered = items.filter((it) => !it.held);
  if (offered.every((it) => ids.has(it.id))) return { mode: "all", items };
  return {
    mode: "partial",
    items: items.map((it) => (ids.has(it.id) ? { ...it, held: true, holdReason: "sales" as const } : it)),
  };
}

/**
 * Ryoma 2026-10-07: once sales said Tolak, the quote is never approved on
 * submit, even by a manager and even inside policy, until a manager has
 * explicitly approved it after that Tolak, however often it is reopened in
 * between (counting revisions let a second reopen slip through).
 *
 * Ordered by audit_log ids, which only grow: a Tolak is logged as
 * "sales_rejected" in the import's own transaction, a manager's decision as
 * "approved" (an auto-approval is "auto_approved" and doesn't count).
 * Timestamps can't order them: the tables keep different precisions. One
 * row, `open` 1 or 0; bind the quote id twice.
 */
export const SALES_REJECTION_OPEN_SQL = `SELECT
  COALESCE((SELECT MAX(id) FROM audit_log WHERE entity = 'quote' AND entity_id = ? AND action = 'sales_rejected'), 0)
  > COALESCE((SELECT MAX(id) FROM audit_log WHERE entity = 'quote' AND entity_id = ? AND action = 'approved'), 0) AS open`;

/**
 * A sales-check import is written only if the quote is still at the version
 * and status it was checked at: otherwise two imports of one file could both
 * apply (the second putting the first's rejected line back on offer), or an
 * import could change a quote that was sent in between. Run first in the
 * import's batch, it fails the whole batch (json() of a non-JSON string
 * raises) so the write is atomic with the check; bind id, version, status.
 */
export const SALES_REVIEW_GUARD_SQL = `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM quotes WHERE id = ? AND version = ? AND status = ?) THEN 1 ELSE json('quote changed') END AS ok`;

export const SALES_REVIEW_STALE =
  "Quotation ini berubah sejak file cek harga dibaca (sudah diimpor, diubah, atau dikirim). Muat ulang halaman, lalu impor lagi bila perlu.";
