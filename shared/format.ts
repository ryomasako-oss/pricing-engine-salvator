/* Formatting helpers shared by the UI, exports, and AI prompts. */

export const grp = (n: number): string =>
  Math.round(Number(n) || 0)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export const rp = (n: number): string =>
  (n < 0 ? "−Rp " : "Rp ") + grp(Math.abs(Number(n) || 0));

/** "12,5%"; a negative gets the true minus sign "−" (U+2212), like rp(), not a hyphen. */
export const pct = (x: number, d = 1): string => {
  const v = (Number(x) || 0) * 100;
  const s = Math.abs(v).toFixed(d).replace(".", ",") + "%";
  return v < 0 && Number(Math.abs(v).toFixed(d)) !== 0 ? `−${s}` : s;
};

export const uid = (): string => Math.random().toString(36).slice(2, 10);

/**
 * SQLite's datetime('now') is UTC written without a zone ("2026-11-08 15:31:00");
 * `new Date()` would read it as local time, 7 hours early in WIB. Every such
 * string the server stores is UTC (datetime('now'), toISOString), so read it as UTC.
 */
const asDate = (d: string | number | Date): Date =>
  typeof d === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(d) ? new Date(`${d.replace(" ", "T")}Z`) : new Date(d);

export const fmtDate = (d: string | number | Date): string => {
  try {
    return asDate(d).toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
};

export const fmtDateTime = (d: string | number | Date): string => {
  try {
    return asDate(d).toLocaleString("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(d);
  }
};

/** Parses Indonesian- and English-formatted numbers out of spreadsheet cells. */
export function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  let s = String(v ?? "")
    .replace(/\s/g, "")
    // "Rp. 15.000" and "15.000,-": the dot after Rp and the ",-" ending aren't decimals.
    .replace(/^(-?)(?:rp|idr)\.?/i, "$1")
    .replace(/[,.]-$/, "");
  if (!s) return NaN;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isNaN(n) ? NaN : n;
}
