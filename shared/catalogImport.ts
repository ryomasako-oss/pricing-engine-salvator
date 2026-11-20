/* Impor katalog lewat ACC (2026-11-20): what an import row does to an item. One rule set, used when the
   upload is turned into drafts (to skip rows that change nothing) and when the draft list shows
   "sebelum → sesudah". The SQL that really writes is UPSERT_ITEM_SQL in server/worker/routes/catalog.ts and
   must give the same result. */

import { cleanUnits, sameUom } from "./uom.js";
import type { UnitFactor } from "./types.js";

export type ImportMode = "merge" | "replace";

/** A spreadsheet row as the upload sends it. */
export interface ImportRow {
  code: string;
  name: string;
  uom?: string;
  cogs?: number;
  list_price?: number;
  stock?: number;
  category?: string;
  units?: UnitFactor[];
}

/** An item as an import sees it. Cost and price are missing for a viewer without `view_costs`. */
export interface ImportItem {
  name: string;
  uom: string;
  cogs?: number;
  list_price?: number;
  stock: number;
  category: string;
  units: UnitFactor[];
}

/**
 * The item after the row is applied. merge: a zero or blank never overwrites; replace: the file wins,
 * except a blank unit. `keepCogs` = the item already has a purchase price from Accurate, so COGS stays.
 * `cur` null = a new item (starts at stock 0, then takes the file's stock).
 */
export function importNext(mode: ImportMode, row: ImportRow, cur: ImportItem | null, keepCogs: boolean): ImportItem {
  const replace = mode === "replace";
  const cogs = row.cogs ?? 0;
  const price = row.list_price ?? 0;
  const category = row.category ?? "";
  if (!cur) {
    const uom = row.uom || "Pcs";
    return { name: row.name, uom, cogs, list_price: price, stock: row.stock ?? 0, category, units: row.units ? cleanUnits(uom, row.units) : [] };
  }
  const uom = row.uom ? row.uom : cur.uom;
  return {
    name: row.name,
    uom,
    cogs: keepCogs ? cur.cogs : cogs > 0 || replace ? cogs : cur.cogs,
    list_price: price > 0 || replace ? price : cur.list_price,
    stock: row.stock ?? cur.stock,
    category: category !== "" || replace ? category : cur.category,
    units: row.units ? cleanUnits(uom || "Pcs", row.units) : cur.units,
  };
}

const sameUnits = (a: UnitFactor[], b: UnitFactor[]) =>
  a.length === b.length && a.every((u) => b.some((n) => sameUom(n.uom, u.uom) && n.factor === u.factor));

/** True when applying the row leaves the existing item exactly as it is. */
export function importUnchanged(a: ImportItem, b: ImportItem): boolean {
  return (
    a.name === b.name && a.uom === b.uom && a.cogs === b.cogs && a.list_price === b.list_price &&
    a.stock === b.stock && a.category === b.category && sameUnits(a.units, b.units)
  );
}

const unitsText = (u: UnitFactor[]) => u.map((x) => `${x.uom} ${x.factor}`).join(", ") || "tidak ada";

/** One line per change of an import draft, for the Gudang list. `payload` is the file row plus `mode`, or `{ delete: true }`. */
export function importChanges(payload: Record<string, unknown>, before: Record<string, unknown>): string[] {
  if (payload.delete) return ["Dihapus dari katalog (tidak ada di file, impor ganti seluruh katalog)"];
  const row = payload as unknown as ImportRow & { mode?: ImportMode };
  const mode = row.mode ?? "merge";
  const cur = typeof before.name === "string" ? (before as unknown as ImportItem) : null;
  const next = importNext(mode, row, cur, false);
  const out: string[] = [];
  const money = (n: number) => n.toLocaleString("id-ID");
  if (!cur) {
    out.push(`Barang baru: ${next.name}, satuan ${next.uom}${next.category ? `, kategori ${next.category}` : ""}`);
    if (row.cogs !== undefined) out.push(`COGS ${money(next.cogs ?? 0)}, harga jual ${money(next.list_price ?? 0)}`);
    if (row.stock !== undefined) out.push(`Stok: 0 → ${next.stock}`);
    if (row.units?.length) out.push(`Satuan tambahan: ${unitsText(next.units)}`);
    return out;
  }
  if (next.name !== cur.name) out.push(`Nama: ${cur.name} → ${next.name}`);
  if (!sameUom(next.uom, cur.uom)) out.push(`Satuan dasar: ${cur.uom} → ${next.uom}`);
  // Hidden from a viewer without view_costs: the server leaves the numbers out, so there is nothing to compare.
  if (cur.cogs !== undefined && next.cogs !== cur.cogs) out.push(`COGS: ${money(cur.cogs)} → ${money(next.cogs ?? 0)}`);
  if (cur.list_price !== undefined && next.list_price !== cur.list_price) out.push(`Harga jual: ${money(cur.list_price)} → ${money(next.list_price ?? 0)}`);
  if (next.category !== cur.category) out.push(`Kategori: ${cur.category || "kosong"} → ${next.category || "kosong"}`);
  if (next.stock !== cur.stock) out.push(`Stok: ${cur.stock} → ${next.stock}`);
  if (!sameUnits(next.units, cur.units)) out.push(`Satuan tambahan: ${unitsText(cur.units)} → ${unitsText(next.units)}`);
  return out.length ? out : ["Tidak ada yang berubah"];
}

/** Reply of POST /catalog/import, as the pages show it. `canReview` = the user sees the Gudang menu (admin). */
export interface ImportQueued { importId: number | null; drafts: number; unchanged: number }
export function importQueuedNote(r: ImportQueued, canReview: boolean): string {
  if (!r.drafts) return "Tidak ada yang berubah: semua barang di file sama dengan katalog.";
  const skipped = r.unchanged ? ` ${r.unchanged.toLocaleString("id-ID")} barang yang tidak berubah dilewati.` : "";
  return `File masuk draf (${r.drafts.toLocaleString("id-ID")} barang), menunggu ACC admin${canReview ? " di menu Gudang" : ""}.${skipped}`;
}
