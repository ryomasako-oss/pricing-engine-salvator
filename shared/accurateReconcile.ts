/* Cek silang katalog dengan Accurate (Ryoma 2026-10-08): Accurate adalah
   acuan awal, tapi bisa salah, jadi selisihnya dilaporkan dan, untuk yang
   perlu ditindak, diberitahukan lewat "Perlu diperbaiki".

   Satu tugas terbuka per jenis masalah (bukan per barang, supaya ribuan baris
   tidak membanjiri daftar). Tugas ditutup sendiri begitu jenis itu sudah
   tidak punya selisih. Jenis yang hanya informatif (notify: false) muncul di
   laporan saja, karena angkanya bisa besar dan wajar (barang jasa yang tidak
   ada di Accurate, barang yang memang belum diberi harga jual). */

export type CheckKey =
  | "price_below_cogs"
  | "price_diff"
  | "uom_diff"
  | "suspended_in_accurate"
  | "negative_stock"
  | "missing_in_accurate"
  | "no_price_in_accurate";

export interface CheckDef {
  label: string;
  /** What it means and what to do, in the manager's words. */
  todo: string;
  notify: boolean;
}

/** In display order, most serious first. */
export const CHECKS: Record<CheckKey, CheckDef> = {
  price_below_cogs: {
    label: "Harga jual Accurate di bawah COGS katalog",
    todo: "Salah satunya keliru: harga jual di Accurate atau COGS di katalog. Cek sebelum harga ini dipakai untuk penawaran.",
    notify: true,
  },
  price_diff: {
    label: "Harga jual katalog beda dengan Accurate",
    todo: "Putuskan mana yang benar. \"Terapkan\" di panel Sinkron Accurate memakai harga Accurate.",
    notify: true,
  },
  uom_diff: {
    label: "Satuan dasar beda dengan Accurate",
    todo: "Samakan satuan dasar. Barang yang sudah punya COGS tidak diubah otomatis karena COGS-nya per satuan lama.",
    notify: true,
  },
  suspended_in_accurate: {
    label: "Barang dinonaktifkan di Accurate, masih ada di katalog",
    todo: "Cek apakah barang ini masih dijual. Kalau tidak, hentikan penawarannya.",
    notify: true,
  },
  negative_stock: {
    label: "Stok minus di Accurate",
    todo: "Stok di Accurate tidak masuk akal. Cek pencatatan stoknya di Accurate sebelum stok dipakai.",
    notify: true,
  },
  missing_in_accurate: {
    label: "Ada di katalog, tidak ada di Accurate",
    todo: "Bisa salah kode, atau barang non-Accurate (jasa, barang lama). Hanya informasi, tidak ada pemberitahuan.",
    notify: false,
  },
  no_price_in_accurate: {
    label: "Harga jual di Accurate kosong",
    todo: "Accurate tidak punya harga jual untuk barang ini, jadi \"Terapkan\" tidak mengisinya. Hanya informasi.",
    notify: false,
  },
};

export const CHECK_KEYS = Object.keys(CHECKS) as CheckKey[];
export const isCheckKey = (k: string): k is CheckKey => k in CHECKS;

export type ReconcileCounts = Record<CheckKey, number>;

export interface ExampleRow {
  code: string;
  name: string;
  /** What the catalog has / what Accurate has, already formatted. */
  catalog: string;
  accurate: string;
}

export const EXAMPLES_IN_TASK = 3;

const idr = (n: number) => new Intl.NumberFormat("id-ID").format(Math.round(n));
export const fmtMoney = (n: unknown) => `Rp ${idr(Number(n) || 0)}`;

/** The text of the single open task for one check. */
export function checkDetail(key: CheckKey, count: number, examples: ExampleRow[]): string {
  const def = CHECKS[key];
  const listed = examples.slice(0, EXAMPLES_IN_TASK);
  const shown = listed
    .map((e) => (e.catalog || e.accurate ? `${e.code} (katalog ${e.catalog || "-"}, Accurate ${e.accurate || "-"})` : e.code))
    .join("; ");
  const more = count > listed.length ? ", dan lainnya" : "";
  return `${count} barang. ${def.todo}${shown ? ` Contoh: ${shown}${more}.` : ""} Daftar lengkap: Katalog → Sinkron Accurate → Cek silang.`;
}

export interface DesiredCheckTask {
  key: CheckKey;
  label: string;
  count: number;
  detail: string;
}

/** The open tasks the current counts call for. */
export function desiredTasks(counts: ReconcileCounts, examples: Partial<Record<CheckKey, ExampleRow[]>>): DesiredCheckTask[] {
  return CHECK_KEYS.filter((k) => CHECKS[k].notify && counts[k] > 0).map((key) => ({
    key,
    label: CHECKS[key].label,
    count: counts[key],
    detail: checkDetail(key, counts[key], examples[key] ?? []),
  }));
}
