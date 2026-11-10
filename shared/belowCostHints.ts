/* Kemungkinan salah data di laporan "Jual < Beli" (pemilik, 2026-11-10: "bisa ngecek ga kesalahan
   data kita nanti dari mana? PPN? satuan yang salah, 1 roll ternyata 1 lusin roll?").
   A loss row is only a guess at a real loss; these marks say when the numbers look like a recording
   slip instead. They never hide a row or change the loss: the user checks the invoice in Accurate. */

export type HintKind = "unit" | "ppn" | "sale_unit" | "old_pi" | "no_list";

export interface Hint {
  kind: HintKind;
  label: string;
}

/** Pack sizes common in the catalog (lusin, gross, rim, box): cost ≈ k × price smells of a unit slip. */
const PACKS = [2, 3, 4, 5, 6, 8, 10, 12, 20, 24, 25, 36, 48, 50, 100, 144];
/** PI older than this many days before the SI: the cost may simply be stale. */
export const OLD_PI_DAYS = 180;

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function belowCostHints(r: {
  /** Per base unit, before PPN. */
  net: number;
  cost: number;
  saleDate: string;
  receiptDate: string;
  listPrice: number;
  saleUnit: string;
  saleRatio: number;
  baseUom: string;
}): Hint[] {
  const out: Hint[] = [];
  const ratio = r.net > 0 ? r.cost / r.net : 0;
  const pack = PACKS.find((k) => Math.abs(ratio / k - 1) <= 0.08);
  if (pack) out.push({ kind: "unit", label: `Cek satuan: harga beli ≈ ${pack}× harga jual` });
  else if (ratio >= 1.08 && ratio <= 1.14) out.push({ kind: "ppn", label: "Cek PPN: selisih ≈ 11%, mungkin salah centang \"termasuk pajak\"" });
  if (r.saleUnit && !same(r.saleUnit, r.baseUom) && !(r.saleRatio > 1)) {
    out.push({ kind: "sale_unit", label: `Cek satuan: isi 1 ${r.saleUnit} di faktur jual belum diisi` });
  }
  const age = days(r.receiptDate, r.saleDate);
  if (age > OLD_PI_DAYS) out.push({ kind: "old_pi", label: `PI lama: ${age} hari sebelum SI` });
  if (!(r.listPrice > 0)) out.push({ kind: "no_list", label: "Harga list kosong: cek satuan otomatis tidak jalan" });
  return out;
}

/** A mark that points at a slip; "harga list kosong" only says a check could not run. */
export const looksLikeSlip = (hints: Hint[]) => hints.some((h) => h.kind !== "no_list");
