/* Server-side rules for a sales "Cek harga" import (PE-2). Both backends
   call checkSalesReview, so Express and the Worker refuse the same files
   with the same messages.

   What sales send back is only {id, decision, reason} per line, plus the
   revision and version the file was made from. Prices are not part of it,
   so nothing in the file can change a price. */

export type SalesDecision = "acc" | "tolak";

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
