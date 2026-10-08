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

/** Why a line is held (QuoteItem.holdReason); a line without one is held for its COGS. */
export type HoldReason = "cogs" | "sales" | "new_item";

export interface HoldInfo {
  /** Badge text and colour on a held line. */
  badge: string;
  tone: "amber" | "blue";
  /** Tooltip for a manager / for staff (no cost talk for staff). */
  manager: string;
  staff: string;
  /** Flag in the line's price explanation. */
  flag: string;
  /** Column "Ditahan" of the analysis sheet. */
  sheet: string;
  /** "Cara harga keluar" of the sales "Cek harga" Excel. */
  how: string;
}

const HOLD_INFO: Record<HoldReason, HoldInfo> = {
  cogs: {
    badge: "Ditahan",
    tone: "amber",
    manager: "COGS item ini perlu dicek manajer. Tidak ikut total dan dokumen sampai dilepas.",
    staff: "Harga item ini sedang dicek manajer. Tidak ikut total dan dokumen; di dokumen ditulis sebagai item menyusul.",
    flag: "Ditahan: COGS perlu dicek manajer, tidak ikut total",
    sheet: "Ya (COGS perlu dicek)",
    how: "Ditahan: COGS di katalog perlu dicek manajer. Baris ini tidak ikut penawaran dan tidak perlu dicek.",
  },
  sales: {
    badge: "Menyusul",
    tone: "blue",
    manager: "Harganya ditolak sales saat cek. Tidak ikut total dan dokumen; ditulis sebagai item menyusul dan ada di Perlu diperbaiki.",
    staff: "Harganya ditolak saat cek sales. Tidak ikut total dan dokumen; ditulis sebagai item menyusul dan ada di Perlu diperbaiki.",
    flag: "Menyusul: harganya ditolak sales, tidak ikut total",
    sheet: "Ya (ditolak sales, menyusul)",
    how: "Menyusul: ditolak di cek sebelumnya, ada di Perlu diperbaiki. Baris ini tidak ikut penawaran dan tidak perlu dicek.",
  },
  new_item: {
    badge: "Menunggu Accurate",
    tone: "blue",
    manager: "Barang baru yang belum ada di Accurate. Tidak ikut total dan dokumen sampai masuk katalog; ditulis sebagai item menyusul.",
    staff: "Barang baru, menunggu dibuat di Accurate. Tidak ikut total dan dokumen; di dokumen ditulis sebagai item menyusul.",
    flag: "Menunggu Accurate: barang baru belum ada di katalog, tidak ikut total",
    sheet: "Ya (barang baru, menunggu Accurate)",
    how: "Menunggu Accurate: barang baru yang belum ada di katalog. Baris ini tidak ikut penawaran dan tidak perlu dicek.",
  },
};

export const holdInfo = (reason?: HoldReason | null): HoldInfo => HOLD_INFO[reason ?? "cogs"];
