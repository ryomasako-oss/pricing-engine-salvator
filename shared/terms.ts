/* ============================================================
   Commercial terms on a quotation: term of payment and warranty.

   Meeting 2026-10-05: both must have their own field and must appear on
   the file the customer receives, so a quote cannot be submitted without
   them. They are numbers (days, years) rather than free text so every
   document states them the same way.

   Quotes made before this only have the free-text `payment` ("30 hari
   setelah invoice"). That text is kept: with `paymentDays` set it is the
   note after the number, without it it is shown as-is, so old documents
   render exactly as before.
   ============================================================ */

import type { QuoteMeta } from "./types.js";

/** "30 hari setelah invoice" -> { days: 30, note: "setelah invoice" }. No leading number -> days null. */
export function splitPaymentTerms(text: string | undefined): { days: number | null; note: string } {
  const t = (text ?? "").trim();
  const m = /^(\d{1,3})\s*hari\b\s*(.*)$/i.exec(t);
  return m ? { days: Number(m[1]), note: m[2].trim() } : { days: null, note: t };
}

const has = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

const fmtNum = (n: number) => String(n).replace(".", ",");

/** What the customer document says for term of payment, or "" when nothing is set. */
export function paymentLabel(meta: Pick<QuoteMeta, "payment" | "paymentDays">): string {
  const note = (meta.payment ?? "").trim();
  if (!has(meta.paymentDays)) return note;
  const base = meta.paymentDays === 0 ? "Tunai (0 hari)" : `${meta.paymentDays} hari`;
  return note ? `${base} ${note}` : base;
}

/** What the customer document says for warranty, or "" when nothing is set. */
export function warrantyLabel(meta: Pick<QuoteMeta, "warrantyYears" | "warrantyNote">): string {
  if (!has(meta.warrantyYears)) return "";
  const note = (meta.warrantyNote ?? "").trim();
  const base = meta.warrantyYears === 0 ? "Tanpa garansi" : `${fmtNum(meta.warrantyYears)} tahun`;
  return note ? `${base} (${note})` : base;
}

/** Terms still missing before the quote may be submitted; empty when complete. */
export function missingTerms(meta: Partial<Pick<QuoteMeta, "paymentDays" | "warrantyYears">> | undefined): string[] {
  const out: string[] = [];
  if (!has(meta?.paymentDays)) out.push("Term of payment (hari)");
  if (!has(meta?.warrantyYears)) out.push("Garansi (tahun)");
  return out;
}

export const missingTermsMessage = (missing: string[]) =>
  `Lengkapi dulu di tab Dokumen sebelum diajukan: ${missing.join(" dan ")}. Keduanya wajib tampil di penawaran ke customer.`;

/**
 * Payment terms for a new quote, from the client's stored terms (free text).
 * "30 hari setelah invoice" -> 30 days + note; text without a number of days
 * stays as the note and the days are left for the rep to fill in. Warranty has
 * no default: it is decided per quote.
 */
export function defaultPayment(clientTerms: string | undefined): Pick<QuoteMeta, "payment" | "paymentDays"> {
  const { days, note } = splitPaymentTerms(clientTerms || "30 hari setelah invoice");
  return { payment: note, paymentDays: days };
}
