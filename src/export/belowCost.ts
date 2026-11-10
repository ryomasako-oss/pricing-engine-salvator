/* Laporan "Jual di bawah beli" as Excel: the rows on screen (after the filter), numbers as numbers. */

import * as XLSX from "xlsx";

export interface BelowCostExportRow {
  invoiceNo: string;
  transDate: string;
  customerName: string;
  code: string;
  name: string;
  net: number;
  cost: number;
  receiptNo: string;
  lossTotal: number;
}

export function belowCostSheet(rows: BelowCostExportRow[]): XLSX.WorkBook {
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      "Nomor SI": r.invoiceNo,
      "Tanggal SI": r.transDate,
      Klien: r.customerName,
      "Kode Barang": r.code,
      "Nama Barang": r.name,
      "Harga Jual (sebelum PPN)": r.net,
      "Harga Beli PI (sebelum PPN)": r.cost,
      "Nomor PI": r.receiptNo,
      "Selisih Rugi": r.lossTotal,
    })),
  );
  sheet["!cols"] = [{ wch: 20 }, { wch: 12 }, { wch: 36 }, { wch: 14 }, { wch: 44 }, { wch: 18 }, { wch: 20 }, { wch: 20 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Jual di bawah beli");
  return wb;
}

export function exportBelowCost(rows: BelowCostExportRow[], from: string, to: string): void {
  XLSX.writeFile(belowCostSheet(rows), `jual-di-bawah-beli-${from}-sd-${to}.xlsx`);
}
