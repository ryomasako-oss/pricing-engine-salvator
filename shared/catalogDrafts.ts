/* Draf Perbaikan Divisi Gudang (2026-11-19): what an Admin Gudang's draft changes, in words, for the
   draft list and the catalog row. Server: server/worker/routes/catalog.ts (saveDraft, /drafts). */

import { importChanges } from "./catalogImport.js";
import { ratioText, sameUom } from "./uom.js";
import type { CatalogDraftMark, UnitFactor } from "./types.js";

/** Payload / before shapes per kind, as saveDraft stores them. */
export interface DraftPayloads {
  barcode: { barcode?: string | null; generate?: boolean };
  unit: { factor: number; base: string; barcode?: string; generate?: boolean };
  edit: { name: string; uom: string; category: string; units?: UnitFactor[] };
  /** Cycle count (2026-11-25): hasil hitung di satu gudang (satuan dasar) dan stok Accurate gudang itu saat diajukan.
   *  Draf lama (sebelum 2026-11-25) hanya punya `stock`. */
  stock: { stock: number; warehouse?: string; accurate?: number | null; accurate_source?: "live" | "sync" | null };
  /** The file row plus its mode. Items an "ganti seluruh katalog" file leaves out are deleted by the last ACC, not drafted. */
  import: Record<string, unknown>;
}

export const NO_CHANGE = "Tidak ada yang berubah";

const unitsText = (units: UnitFactor[], base: string) => units.map((u) => ratioText(u.uom, u.factor, base)).join(", ") || "tidak ada";

/** One line per change, e.g. "Barcode Box: kosong → 8991234567890". */
export function draftChanges(kind: CatalogDraftMark["kind"], uom: string, payload: Record<string, unknown>, before: Record<string, unknown>, purchased = false): string[] {
  if (kind === "barcode") {
    const p = payload as DraftPayloads["barcode"];
    const was = (before.barcode as string | null) ?? "kosong";
    return [`Barcode ${uom}: ${was} → ${p.generate ? "buatkan barcode otomatis" : p.barcode ?? "dihapus"}`];
  }
  if (kind === "unit") {
    const p = payload as DraftPayloads["unit"];
    const code = p.barcode ? `, barcode ${p.barcode}` : p.generate ? ", barcode dibuatkan otomatis" : "";
    return [`Satuan baru: ${ratioText(uom, p.factor, p.base)}${code}`];
  }
  if (kind === "import") return importChanges(payload, before, purchased);
  if (kind === "stock") {
    const p = payload as DraftPayloads["stock"];
    if (p.warehouse === undefined) return [`Stok: ${(before as Partial<DraftPayloads["stock"]>).stock ?? "kosong"} → ${p.stock}`];
    const n = (x: number) => x.toLocaleString("id-ID");
    if (p.accurate == null) return [`Hitung ${p.warehouse}: ${n(p.stock)} · stok Accurate saat dihitung tidak terbaca`];
    const diff = p.stock - p.accurate;
    return [
      `Hitung ${p.warehouse}: ${n(p.stock)} · Accurate saat dihitung ${n(p.accurate)} · ` +
        (diff === 0 ? "sama" : `selisih ${diff > 0 ? "+" : ""}${n(diff)}`),
    ];
  }
  const p = payload as DraftPayloads["edit"];
  const b = before as Partial<DraftPayloads["edit"]>;
  const out: string[] = [];
  if (p.name !== b.name) out.push(`Nama: ${b.name} → ${p.name}`);
  if (!sameUom(p.uom, b.uom ?? "")) out.push(`Satuan dasar: ${b.uom} → ${p.uom}`);
  if (p.category !== (b.category ?? "")) out.push(`Kategori: ${b.category || "kosong"} → ${p.category || "kosong"}`);
  if (p.units) {
    const was = b.units ?? [];
    const same = was.length === p.units.length && was.every((u) => p.units!.some((n) => sameUom(n.uom, u.uom) && n.factor === u.factor));
    if (!same) out.push(`Satuan tambahan: ${unitsText(was, b.uom ?? p.uom)} → ${unitsText(p.units, p.uom)}`);
  }
  return out.length ? out : [NO_CHANGE];
}
