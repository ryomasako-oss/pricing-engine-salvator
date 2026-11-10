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
  /** Short, for the table: "Satuan tertukar? (≈12×)". */
  label: string;
  /** What it means and what to check, in plain words (pemilik, 11 Nov: "orang awam pun paham"). */
  detail: string;
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
  const h = (kind: HintKind, label: string, detail: string) => out.push({ kind, label, detail });
  // Found in Accurate on 10 Nov (laporan "Telusur selisih jual di bawah beli"): these are no sale at a price.
  if (r.invoiceTotal === 0 && r.lineAmount === 0) {
    h("no_value", "Nota jual Rp 0",
      "Seluruh nota jual ini bernilai Rp 0. Biasanya ini nota tukar barang retur, atau nota ganda yang sengaja tidak ditagih. Jadi barangnya bukan dijual murah. Cek keterangan nota di Accurate.");
    return out;
  }
  if (r.name && GENERIC.test(r.name)) {
    h("generic", "Kode umum/jasa",
      "Kode ini dipakai untuk banyak barang atau jasa yang berbeda (misalnya suku cadang). Harga beli satu barang dibandingkan dengan harga jual barang lain, jadi selisihnya tidak bermakna.");
  }
  if (r.lineAmount === 0 && (r.invoiceTotal ?? 0) > 0) {
    if (r.invoicePrice && r.invoicePrice > 0) {
      h("bonus_sale", "Bonus ke klien",
        `Barang ini diberikan gratis ke klien sebagai bonus (misalnya "beli 20 gratis 1"). Kalau dihitung bersama barang yang dibayar di nota yang sama, harga jualnya sekitar Rp ${rupiah(r.invoicePrice)} per ${r.baseUom || "satuan"}.`);
    } else {
      h("bonus_sale", "Barang gratis ke klien",
        "Barang ini diberikan gratis ke klien, dan tidak ada barang yang sama yang dibayar di nota ini. Cek apakah ini bonus, sampel, atau pengganti barang.");
    }
    return out;
  }
  const ratio = r.net > 0 ? r.cost / r.net : 0;
  const pack = PACKS.find((k) => Math.abs(ratio / k - 1) <= 0.08);
  if (pack) {
    h("unit", `Satuan tertukar? (≈${pack}×)`,
      `Harga beli sekitar ${pack} kali harga jual. Selisih sebesar ini biasanya karena satuan tertukar, misalnya harga per lusin atau per dus tercatat sebagai harga per buah. Cek satuan di nota beli dan nota jual.`);
  } else if (ratio >= 1.08 && ratio <= 1.14) {
    h("ppn", "Urusan PPN?",
      'Selisihnya sekitar 11%, sama dengan PPN. Kemungkinan salah satu nota keliru mencentang (atau tidak mencentang) "termasuk pajak". Cek centang pajak di nota beli dan nota jual.');
  }
  if (r.saleUnit && !same(r.saleUnit, r.baseUom) && !(r.saleRatio > 1)) {
    h("sale_unit", "Isi satuan belum diisi",
      `Nota jual memakai satuan ${r.saleUnit}, tapi isi per ${r.saleUnit} belum diisi di Accurate, jadi sistem menganggap 1 ${r.saleUnit} = 1 ${r.baseUom}. Lengkapi isi satuannya di data barang Accurate.`);
  }
  // Two others at least, so one odd invoice doesn't make the usual price.
  const usualCost = (r.otherCosts?.length ?? 0) >= 2 ? median(r.otherCosts!) : null;
  if (!pack && usualCost && r.cost > COST_OUTLIER * usualCost) {
    h("input_cost", "Harga beli tidak biasa",
      `Harga beli di nota ini jauh di atas biasanya (biasanya sekitar Rp ${rupiah(usualCost)}). Mungkin salah ketik angka, atau pembelian mendadak dalam jumlah kecil dengan harga eceran. Cek nota belinya.`);
  }
  const usualPrice = (r.otherPrices?.length ?? 0) >= 2 ? median(r.otherPrices!) : null;
  if (!pack && usualPrice && r.net < PRICE_OUTLIER * usualPrice) {
    h("input_price", "Harga jual tidak biasa",
      `Harga jual di nota ini jauh di bawah biasanya (biasanya sekitar Rp ${rupiah(usualPrice)}). Mungkin salah ketik angka di nota jual. Cek nota jualnya.`);
  }
  if (r.detailName && r.name) {
    const catalog = words(r.name);
    if (catalog.size && ![...words(r.detailName)].some((w) => catalog.has(w))) {
      h("code", "Nama barang beda",
        `Di nota tertulis "${r.detailName.trim()}", yang tidak mirip dengan nama barang di katalog. Mungkin kode barang yang dipilih di nota keliru.`);
    }
  }
  const age = days(r.receiptDate, r.saleDate);
  if (age > OLD_PI_DAYS) {
    h("old_pi", "Pembelian sudah lama",
      `Harga beli diambil dari pembelian ${age} hari sebelum penjualan. Harga beli saat barang dijual bisa sudah berbeda.`);
  }
  if ((r.discount ?? 0) >= BIG_DISCOUNT) {
    const pct = Math.round(r.discount! * 100);
    h("discount", `Diskon nota ${pct}%`, `Nota jual ini memberi diskon ${pct}% untuk seluruh nota, yang ikut menurunkan harga jual barang ini.`);
  }
  if (!(r.listPrice > 0)) {
    h("no_list", "Harga list kosong",
      "Harga jual standar barang ini belum diisi di katalog, jadi pemeriksaan satuan otomatis tidak bisa jalan sepenuhnya.");
  }
  return out;
}

/* Three groups, each with what it means and what to do (pemilik, 11 Nov: the dozen causes were
   confusing; "Tanpa tanda" said nothing). The detailed reasons stay under each row. */
export const GROUPS = [
  {
    key: "data",
    label: "Data perlu dibetulkan",
    tone: "amber",
    kinds: ["unit", "sale_unit", "ppn", "input_cost", "input_price", "code"],
    why: "Selisih ini kemungkinan besar bukan rugi, tapi karena ada yang tercatat keliru di Accurate: satuan, centang pajak, angka harga, atau kode barang.",
    todo: "Betulkan nota atau data barangnya di Accurate. Setelah sinkron, selisihnya akan hilang sendiri dari laporan ini.",
  },
  {
    key: "other",
    label: "Bukan penjualan biasa",
    tone: "blue",
    kinds: ["no_value", "generic", "bonus_sale"],
    why: "Barang ini keluar bukan sebagai penjualan dengan harga normal: bonus ke klien, tukar barang retur, nota ganda yang tidak ditagih, atau kode yang dipakai untuk banyak barang.",
    todo: "Tidak perlu dibetulkan. Cukup diketahui bahwa ini bukan karena harga jual yang terlalu murah.",
  },
  {
    key: "none",
    label: "Belum ketemu penyebabnya",
    tone: "grey",
    kinds: [],
    why: "Sistem sudah memeriksa satuan, PPN, salah ketik harga, kode barang, bonus, dan nota bernilai nol, dan semuanya tampak wajar. Yang tersisa hanya fakta bahwa harga jual di nota lebih rendah dari harga beli terakhir. Penyebabnya bisa: harga beli sudah naik tapi harga jual ke klien belum disesuaikan, ada harga khusus hasil negosiasi, atau barang dijual dari stok lama yang dulu dibeli lebih murah.",
    todo: "Buka Telusuri untuk melihat riwayat harga beli dan jual, lalu tanyakan ke tim penjualan apakah harga ke klien ini perlu dinaikkan.",
  },
] as const satisfies readonly { key: string; label: string; tone: string; kinds: readonly HintKind[]; why: string; todo: string }[];

export type GroupKey = (typeof GROUPS)[number]["key"];
/** Old name, kept for the filter. */
export type CauseKey = GroupKey;

/** The row's group: a bonus/no-value mark first (it explains the gap), then a data slip, else none. */
export function groupOf(hints: Hint[]): (typeof GROUPS)[number] {
  const has = (g: (typeof GROUPS)[number]) => hints.some((x) => (g.kinds as readonly HintKind[]).includes(x.kind));
  return GROUPS.find((g) => g.key === "other" && has(g)) ?? GROUPS.find((g) => g.key === "data" && has(g)) ?? GROUPS[2];
}

/** A mark that explains the gap; the info marks (old PI, discount, no list price) alone don't. */
export const looksLikeSlip = (hints: Hint[]) => groupOf(hints).key !== "none";

export function matchesCause(hints: Hint[], key: GroupKey | ""): boolean {
  return !key || groupOf(hints).key === key;
}
