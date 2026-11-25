/* Tabel stok pembanding (stok mandiri, 2026-11-25): satu baris per barang yang pernah dihitung, satu kolom per gudang +
   pemilik (hitungan terakhir), total, dan stok Accurate PT sebagai pembanding saja. Selisih dibandingkan dengan Accurate
   PT di gudang yang sama dengan yang dihitung (gudang yang tidak dihitung tidak ikut), dan hanya untuk pemilik Umum/PT:
   Accurate yang terhubung hanya PT. Server: GET /api/stock/book. */

export type BookOwner = "umum" | "pt" | "cv";
export const BOOK_OWNER: Record<BookOwner, string> = { umum: "Umum", pt: "PT", cv: "CV" };

export interface BookCount { code: string; name: string | null; uom: string; warehouse: string; owner: BookOwner; counted: number; counted_at: string; counted_by_name: string | null }
export interface BookAccurate { code: string; warehouse: string; qty: number }

export interface BookColumn { key: string; warehouse: string; owner: BookOwner }
export interface BookRow {
  code: string; name: string | null; uom: string;
  cells: Record<string, number>;
  total: number;
  /** Stok Accurate PT di gudang yang dihitung (Umum/PT); null bila tidak ada baris Umum/PT. */
  accurate: number | null;
  /** Stok Accurate PT semua gudang, untuk keterangan. */
  accurateAll: number;
  diff: number | null;
  lastAt: string; lastBy: string | null;
}

export const bookKey = (warehouse: string, owner: BookOwner) => `${warehouse}|${owner}`;

/** `counts`: hitungan terakhir per barang + gudang + pemilik. */
export function buildBook(counts: BookCount[], accurate: BookAccurate[]): { columns: BookColumn[]; rows: BookRow[] } {
  const cols = new Map<string, BookColumn>();
  const rows = new Map<string, BookRow>();
  const accBy = new Map<string, number>();
  const accAll = new Map<string, number>();
  for (const a of accurate) {
    accBy.set(`${a.code.toLowerCase()}|${a.warehouse.toLowerCase()}`, a.qty);
    accAll.set(a.code.toLowerCase(), (accAll.get(a.code.toLowerCase()) ?? 0) + a.qty);
  }
  const ptWarehouses = new Map<string, Set<string>>();
  for (const k of counts) {
    const key = bookKey(k.warehouse, k.owner);
    if (!cols.has(key)) cols.set(key, { key, warehouse: k.warehouse, owner: k.owner });
    let r = rows.get(k.code);
    if (!r) {
      r = { code: k.code, name: k.name, uom: k.uom, cells: {}, total: 0, accurate: null, accurateAll: accAll.get(k.code.toLowerCase()) ?? 0, diff: null, lastAt: k.counted_at, lastBy: k.counted_by_name };
      rows.set(k.code, r);
    }
    r.cells[key] = k.counted;
    r.total += k.counted;
    if (k.counted_at > r.lastAt) (r.lastAt = k.counted_at), (r.lastBy = k.counted_by_name);
    if (k.owner !== "cv" && k.warehouse) {
      const s = ptWarehouses.get(k.code) ?? new Set<string>();
      s.add(k.warehouse.toLowerCase());
      ptWarehouses.set(k.code, s);
    }
  }
  for (const r of rows.values()) {
    const whs = ptWarehouses.get(r.code);
    if (!whs) continue;
    r.accurate = [...whs].reduce((t, w) => t + (accBy.get(`${r.code.toLowerCase()}|${w}`) ?? 0), 0);
    const counted = Object.entries(r.cells).filter(([k]) => !k.endsWith("|cv") && !k.startsWith("|")).reduce((t, [, v]) => t + v, 0);
    r.diff = counted - r.accurate;
  }
  const order: Record<BookOwner, number> = { umum: 0, pt: 1, cv: 2 };
  const columns = [...cols.values()].sort((a, b) =>
    (a.warehouse === "Utama" ? -1 : 0) - (b.warehouse === "Utama" ? -1 : 0) || a.warehouse.localeCompare(b.warehouse) || order[a.owner] - order[b.owner]);
  return { columns, rows: [...rows.values()].sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code)) };
}
