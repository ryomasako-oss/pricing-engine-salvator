/* Arsip barang: barang yang kalah di ACC Duplikat disembunyikan (bukan dihapus) dari Katalog dan pencarian.
 * Status "Nonaktifkan di Accurate" dihitung saat dibaca (server/catalogArchive.ts), tanpa cron. */

/** belum = barang masih aktif di Accurate, harus dinonaktifkan manual; sudah = non aktif, hilang, atau ditandai manual. */
export type AccurateOffStatus = "belum" | "sudah";

export interface ArchivedItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  category: string;
  stock: number;
  archived_at: string;
  archived_by_name: string | null;
  archived_note: string;
  accurate_off_at: string | null;
  accurate_off_by_name: string | null;
  accurate_status: AccurateOffStatus;
}

export const ACCURATE_OFF_LABEL: Record<AccurateOffStatus, string> = {
  belum: "belum",
  sudah: "sudah",
};
