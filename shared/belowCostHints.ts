/* Kemungkinan salah data di laporan "Jual < Beli" (pemilik, 2026-11-10: "bisa ngecek ga kesalahan
   data kita nanti dari mana? PPN? satuan yang salah, 1 roll ternyata 1 lusin roll? … salah input,
   salah satuan, emang salah harga, atau salah yang mana lagi?").
   A loss row is only a guess at a real loss; these marks say when the numbers look like a recording
   slip instead. They never hide a row or change the loss: the user checks the invoice in Accurate.
   A row with no slip mark is "tanpa tanda": not proof of a loss either (pemilik: "jangan judging"). */

export type HintKind =
  | "unit" // cost ≈ a pack size × price
  | "ppn" // cost ≈ 1,11 × price
  | "sale_unit" // SI in another unit with no ratio
  | "input_cost" // this PI far above the item's other PIs
  | "input_price" // this SI far below the item's other SIs
  | "code" // the invoice wording shares no word with the catalog name
  | "no_value" // the whole SI is 0: a return swap or a "double nota, tidak ditagih"
  | "generic" // a catch-all code (SPAREPARTS, JASA ...): different goods under one code
  | "bonus_sale" // a free line to the client ("beli 20 gratis 1"): the invoice's effective price says more
  | "old_pi" // info: the PI is old
  | "discount" // info: a big invoice discount explains the loss
  | "no_list"; // info: the 3x list-price check could not run

export interface Hint {
  kind: HintKind;
  label: string;
}

/** Pack sizes common in the catalog (lusin, gross, rim, box): cost ≈ k × price smells of a unit slip. */
const PACKS = [2, 3, 4, 5, 6, 8, 10, 12, 20, 24, 25, 36, 48, 50, 100, 144];
/** PI older than this many days before the SI: the cost may simply be stale. */
export const OLD_PI_DAYS = 180;
// shortcut: thresholds picked by eye (owner, 10 Nov); tune once real loss rows have been checked by hand.
const COST_OUTLIER = 1.5;
const PRICE_OUTLIER = 0.5;
const BIG_DISCOUNT = 0.1;

const GENERIC = /SPAREPART|^\s*JASA\b|LAIN-LAIN|ONGKIR|^\s*BIAYA\b/i;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const rupiah = (n: number) => Math.round(n).toLocaleString("id-ID");
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

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
  /** Per base unit cost of the item's other PIs, and net price of its other SIs; [] when unknown. */
  otherCosts?: number[];
  otherPrices?: number[];
  /** How the SI line was worded, and the catalog name. */
  detailName?: string;
  name?: string;
  /** Invoice discount as a share of the sub-total, 0-1. */
  discount?: number;
  /** The SI's sub-total and this line's amount, to tell a free line or a 0 invoice. */
  invoiceTotal?: number;
  lineAmount?: number;
  /** Paid money over every unit of this item on this SI, bonus lines included; per base unit. */
  invoicePrice?: number;
}): Hint[] {
  const out: Hint[] = [];
  // Found in Accurate on 10 Nov (laporan "Telusur selisih jual di bawah beli"): these are no sale at a price.
  if (r.invoiceTotal === 0 && r.lineAmount === 0) {
    return [{ kind: "no_value", label: "Faktur tanpa nilai (tukar retur, nota ganda tidak ditagih, atau sejenisnya): cek keterangan faktur" }];
  }
  if (r.name && GENERIC.test(r.name)) out.push({ kind: "generic", label: "Kode umum/jasa: barang berbeda di bawah satu kode, harga beli dan jual tidak sebanding" });
  if (r.lineAmount === 0 && (r.invoiceTotal ?? 0) > 0) {
    out.push({
      kind: "bonus_sale",
      label: r.invoicePrice && r.invoicePrice > 0 ? `Bonus ke klien (Rp 0); harga efektif barang ini di faktur Rp ${rupiah(r.invoicePrice)}` : "Bonus ke klien (Rp 0) tanpa baris berbayar di faktur ini",
    });
    return out;
  }
  const ratio = r.net > 0 ? r.cost / r.net : 0;
  const pack = PACKS.find((k) => Math.abs(ratio / k - 1) <= 0.08);
  if (pack) out.push({ kind: "unit", label: `Cek satuan: harga beli ≈ ${pack}× harga jual` });
  else if (ratio >= 1.08 && ratio <= 1.14) out.push({ kind: "ppn", label: "Cek PPN: selisih ≈ 11%, cek centang \"termasuk pajak\" di nota" });
  if (r.saleUnit && !same(r.saleUnit, r.baseUom) && !(r.saleRatio > 1)) {
    out.push({ kind: "sale_unit", label: `Cek satuan: isi 1 ${r.saleUnit} di faktur jual belum diisi` });
  }
  // Two others at least, so one odd invoice doesn't make the usual price.
  const usualCost = (r.otherCosts?.length ?? 0) >= 2 ? median(r.otherCosts!) : null;
  if (!pack && usualCost && r.cost > COST_OUTLIER * usualCost) {
    out.push({ kind: "input_cost", label: `Cek input harga beli: biasanya ± Rp ${rupiah(usualCost)}` });
  }
  const usualPrice = (r.otherPrices?.length ?? 0) >= 2 ? median(r.otherPrices!) : null;
  if (!pack && usualPrice && r.net < PRICE_OUTLIER * usualPrice) {
    out.push({ kind: "input_price", label: `Cek input harga jual: biasanya ± Rp ${rupiah(usualPrice)}` });
  }
  if (r.detailName && r.name) {
    const catalog = words(r.name);
    if (catalog.size && ![...words(r.detailName)].some((w) => catalog.has(w))) {
      out.push({ kind: "code", label: `Cek kode barang: di faktur tertulis "${r.detailName.trim()}"` });
    }
  }
  const age = days(r.receiptDate, r.saleDate);
  if (age > OLD_PI_DAYS) out.push({ kind: "old_pi", label: `PI lama: ${age} hari sebelum SI` });
  if ((r.discount ?? 0) >= BIG_DISCOUNT) out.push({ kind: "discount", label: `Diskon faktur ${Math.round(r.discount! * 100)}%` });
  if (!(r.listPrice > 0)) out.push({ kind: "no_list", label: "Harga list kosong: cek satuan otomatis tidak jalan" });
  return out;
}

const INFO: HintKind[] = ["old_pi", "discount", "no_list"];

/** A mark that points at a slip; the info marks only explain or say a check could not run. */
export const looksLikeSlip = (hints: Hint[]) => hints.some((h) => !INFO.includes(h.kind));

/** Filter groups for the report: what the owner asked to tell apart. */
export const CAUSES = [
  { key: "data", label: "Perlu cek data (semua)", kinds: ["unit", "sale_unit", "ppn", "input_cost", "input_price", "code", "no_value", "generic", "bonus_sale"] },
  { key: "unit", label: "Cek satuan", kinds: ["unit", "sale_unit"] },
  { key: "ppn", label: "Cek PPN", kinds: ["ppn"] },
  { key: "input", label: "Cek input harga", kinds: ["input_cost", "input_price"] },
  { key: "code", label: "Cek kode barang", kinds: ["code"] },
  { key: "other", label: "Bukan penjualan biasa / bonus", kinds: ["no_value", "generic", "bonus_sale"] },
  { key: "none", label: "Tanpa tanda", kinds: [] },
] as const satisfies readonly { key: string; label: string; kinds: readonly HintKind[] }[];

export type CauseKey = (typeof CAUSES)[number]["key"];

export function matchesCause(hints: Hint[], key: CauseKey | ""): boolean {
  if (!key) return true;
  if (key === "none") return !looksLikeSlip(hints);
  const kinds: readonly HintKind[] = CAUSES.find((c) => c.key === key)!.kinds;
  return hints.some((h) => kinds.includes(h.kind));
}
