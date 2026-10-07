/* What the customer's document offers when some lines are held (Ryoma,
   2026-10-06): held lines (COGS awaiting a manager, server/cogsCheck.ts
   applyHolds) are left off the document and named in a "will follow" note,
   so the customer isn't left wondering about items they asked for. */

/** Lines on offer, numbered 1..n in their order. */
export function offeredRows<T extends { held?: boolean; lineNo: number }>(rows: T[]): T[] {
  return rows.filter((r) => !r.held).map((r, i) => ({ ...r, lineNo: i + 1 }));
}

/** "2 item menyusul, harganya sedang dikonfirmasi: A, B." or "" when nothing is held. */
export function heldNote(rows: { held?: boolean; name: string }[]): string {
  const names = rows.filter((r) => r.held).map((r) => r.name);
  return names.length ? `${names.length} item menyusul, harganya sedang dikonfirmasi: ${names.join(", ")}.` : "";
}
