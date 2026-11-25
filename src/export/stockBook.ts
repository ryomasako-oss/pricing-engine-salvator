/* Tabel stok pembanding sebagai Excel: baris dan kolom yang sedang tampil (setelah cari/filter). */

import * as XLSX from "xlsx";
import { BOOK_OWNER, type BookColumn, type BookRow } from "@shared/stockBook";

export function exportStockBook(columns: BookColumn[], rows: BookRow[]): void {
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Kode: r.code,
      Barang: r.name ?? "",
      Satuan: r.uom,
      ...Object.fromEntries(columns.map((c) => [`${c.warehouse} · ${BOOK_OWNER[c.owner]}`, r.cells[c.key] ?? ""])),
      "Total pembanding": r.total,
      "Accurate PT (gudang yang dihitung)": r.accurate ?? "",
      Selisih: r.diff ?? "",
      "Accurate PT semua gudang": r.accurateAll,
      "Terakhir dihitung (WIB)": r.lastAt,
      Oleh: r.lastBy ?? "",
    })),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Stok pembanding");
  XLSX.writeFile(wb, `stok-pembanding-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
