/* ============================================================
   Input lines for the interactive familiarity feed.

   The browser reads the client's file (src/import/parsers.ts) and sends
   plain lines; these helpers clean them on the server.
   ============================================================ */

export interface FamiliarityInputLine {
  /** The wording as the client wrote it, without a code column. */
  text: string;
  qty?: number;
  unit?: string;
  /** A code from a separate column, or one recognised at the start of the text. */
  code?: string;
}

/**
 * Raw JSON lines: trim, collapse whitespace, default nothing.
 * A leading list number ("1. Pensil") is dropped, not treated as a code.
 */
export function cleanInputLine(line: FamiliarityInputLine): FamiliarityInputLine {
  let t = String(line.text ?? "").replace(/\s+/g, " ").trim();
  t = t.replace(/^\d{1,3}[).]\s+/, "");
  const qty = Number(line.qty);
  const unit = String(line.unit ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
  const code = String(line.code ?? "").replace(/\s+/g, " ").trim().slice(0, 64);
  return {
    text: t.slice(0, 300),
    ...(Number.isFinite(qty) && qty >= 0 ? { qty } : {}),
    ...(unit ? { unit } : {}),
    ...(code ? { code } : {}),
  };
}

/**
 * Split the code column the client glued into the text ("100591 CAFE_GARAM
 * 1 KG") — but only when `isKnownCode` says the first token is a real catalog
 * or pending code. A product name that starts with a size ("A4 Kertas") is
 * left alone.
 */
export function splitLeadingCode(line: FamiliarityInputLine, isKnownCode: (code: string) => boolean): FamiliarityInputLine {
  if (line.code) return line;
  const m = /^(\S+)\s+(.+)$/.exec(line.text);
  if (!m) return line;
  if (!isKnownCode(m[1])) return line;
  return { ...line, code: m[1], text: m[2] };
}
