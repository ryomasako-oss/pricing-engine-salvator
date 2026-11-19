import { all, get } from "../db.d1";
import { chunks } from "../sqlParams";
import type { CatalogDraftMark, UnitBarcode, UnitFactor } from "../../shared/types";

/* Barcode per SKU (item code + unit). Table: migrations/0039_unit_barcodes.sql. */

/** Check digit of an EAN-13 from its first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

/** Internal EAN-13: prefix 20 (in-store numbers, never a brand's) + 10-digit sequence + check digit. */
export function internalEan13(seq: number): string {
  const first12 = `20${String(seq).padStart(10, "0")}`;
  return first12 + ean13CheckDigit(first12);
}

/** The next internal EAN-13 not yet used by any SKU. */
export async function nextInternalBarcode(db: D1Database): Promise<string> {
  const top = await get<{ seq: number | null }>(
    db,
    "SELECT MAX(CAST(substr(barcode, 3, 10) AS INTEGER)) AS seq FROM catalog_unit_barcodes WHERE generated = 1",
  );
  let seq = (top?.seq ?? 0) + 1;
  // A brand barcode typed in by hand may already hold the next number; skip past it.
  while (await barcodeOwner(db, internalEan13(seq))) seq++;
  return internalEan13(seq);
}

export async function barcodeOwner(db: D1Database, barcode: string) {
  return get<{ code: string; uom: string; name: string | null }>(
    db,
    `SELECT b.code, b.uom, i.name FROM catalog_unit_barcodes b
       LEFT JOIN catalog_items i ON i.code = b.code WHERE b.barcode = ?`,
    barcode,
  );
}

/** "Barcode X sudah dipakai barang CODE NAME (UOM)." */
export const takenMessage = (barcode: string, o: { code: string; uom: string; name: string | null }) =>
  `Barcode ${barcode} sudah dipakai barang ${o.code}${o.name ? ` ${o.name}` : ""} (${o.uom}).`;

/** Barcodes per item code, for the given codes. */
export async function barcodesByCode(db: D1Database, codes: string[]): Promise<Map<string, UnitBarcode[]>> {
  const map = new Map<string, UnitBarcode[]>();
  for (const chunk of chunks(codes, 90)) {
    const rows = await all<{ code: string; uom: string; barcode: string; generated: number }>(
      db,
      `SELECT code, uom, barcode, generated FROM catalog_unit_barcodes
        WHERE code IN (${chunk.map(() => "?").join(",")}) ORDER BY rowid`,
      ...chunk,
    );
    for (const r of rows) {
      if (!map.has(r.code)) map.set(r.code, []);
      map.get(r.code)!.push({ uom: r.uom, barcode: r.barcode, generated: r.generated === 1 });
    }
  }
  return map;
}

/** Units proposed by warehouse staff and not yet reviewed, per item code. */
export async function proposalsByCode(db: D1Database, codes: string[]): Promise<Map<string, UnitFactor[]>> {
  const map = new Map<string, UnitFactor[]>();
  for (const chunk of chunks(codes, 90)) {
    const rows = await all<{ code: string; uom: string; factor: number }>(
      db,
      `SELECT code, uom, factor FROM catalog_unit_proposals
        WHERE code IN (${chunk.map(() => "?").join(",")}) ORDER BY factor`,
      ...chunk,
    );
    for (const r of rows) {
      if (!map.has(r.code)) map.set(r.code, []);
      map.get(r.code)!.push({ uom: r.uom, factor: r.factor });
    }
  }
  return map;
}

/** Admin Gudang drafts waiting for an admin's ACC, per item code (migrations/0043_catalog_drafts.sql). */
export async function draftsByCode(db: D1Database, codes: string[]): Promise<Map<string, CatalogDraftMark[]>> {
  const map = new Map<string, CatalogDraftMark[]>();
  for (const chunk of chunks(codes, 90)) {
    const rows = await all<{ id: number; code: string; kind: CatalogDraftMark["kind"]; uom: string; payload: string }>(
      db,
      `SELECT id, code, kind, uom, payload FROM catalog_drafts
        WHERE status = 'pending' AND code IN (${chunk.map(() => "?").join(",")}) ORDER BY id`,
      ...chunk,
    );
    for (const r of rows) {
      if (!map.has(r.code)) map.set(r.code, []);
      map.get(r.code)!.push({ id: r.id, kind: r.kind, uom: r.uom, payload: JSON.parse(r.payload) });
    }
  }
  return map;
}
