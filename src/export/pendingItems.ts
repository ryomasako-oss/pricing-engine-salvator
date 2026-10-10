/* The list the Accurate admin copies from when creating the new items
   (shared/pendingItems.ts). Plain columns, not Accurate's own import
   template: paste them into that template. */

import * as XLSX from "xlsx";
import type { PendingItem } from "@shared/pendingItems";

export function exportPendingItems(items: PendingItem[], today: string): void {
  const rows = items.map((i) => ({
    "Kode Barang": i.code,
    "Nama Barang": i.name,
    Satuan: i.uom,
    "Perkiraan Harga Jual": i.proposed_price || "",
    Catatan: i.note,
    "Diminta oleh": i.requested_by_name ?? "",
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = [{ wch: 16 }, { wch: 44 }, { wch: 10 }, { wch: 20 }, { wch: 40 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Barang baru");
  XLSX.writeFile(wb, `barang-baru-untuk-accurate-${today}.xlsx`);
}
