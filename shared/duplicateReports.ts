/* "Duplikat" — laporan barang kembar dari gudang.
 *
 * Vee (Paulina, admin gudang) menemukan dua barang di katalog yang ternyata
 * satu barang fisik yang sama (mis. "RANTAI BESI SS304 3MM" dan "RANTAI BESI
 * SS 304 3MM"). Dulu laporan itu dikirim lewat grup WhatsApp; sekarang dia
 * melaporkannya di sini, masuk antrean draf, dan Admin yang memutuskan.
 *
 * Ini BUKAN draf Gudang yang sudah ada (perubahan stok/barcode/satuan):
 * laporan duplikat tinggal di tabelnya sendiri (`duplicate_reports`) dan
 * tampil di tabnya sendiri, jadi antrean yang lama tidak tercampur.
 * Keputusan ACC mencatat barang mana yang dipakai (kept_item_id) dan
 * mengarsipkan barang lain di kelompok (shared/catalogArchive.ts): disembunyikan
 * dari Katalog dan pencarian, tidak dihapus. Tolak tidak mengubah barang apa pun.
 */

export type DuplicateStatus = "open" | "approved" | "rejected";

export interface DuplicateReport {
  id: number;
  /** Laporan yang dicentang bersama berbagi kunci ini; baris lama: "id-<id>". */
  group_key: string;
  item_a_id: number;
  item_a_code: string;
  item_a_name: string;
  item_b_id: number;
  item_b_code: string;
  item_b_name: string;
  note: string;
  status: DuplicateStatus;
  reported_by: number | null;
  reported_by_name: string | null;
  created_at: string;
  /** Barang yang dipilih Admin saat ACC; null sampai diputuskan. */
  kept_item_id: number | null;
  decided_by: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string;
}

export const DUPLICATE_STATUS: Record<DuplicateStatus, { label: string; tone: string }> = {
  open: { label: "Menunggu", tone: "amber" },
  approved: { label: "ACC", tone: "green" },
  rejected: { label: "Ditolak", tone: "red" },
};

/** Pasangan disimpan selalu terurut (id kecil dulu) supaya "A duplikat B"
 *  dan "B duplikat A" jadi satu laporan yang sama, bukan dua. */
export function canonicalPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}
