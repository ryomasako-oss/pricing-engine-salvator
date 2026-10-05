/* ============================================================
   "Is this item's COGS believable?" (meeting 2026-10-05, point 6).

   An item whose COGS looks wrong must not be sold: a price built on a bad
   cost is either a loss or an overcharge. Three signs, checked in order:

   1. No COGS at all.
   2. COGS above the catalog's own selling price (list price): selling at
      list would lose money, so one of the two numbers is wrong.
   3. COGS more than 50% away from its reference COGS: the last value that
      was accepted (catalog_cogs_baseline, kept by triggers in migration
      0009). A jump does not move the reference, so re-importing the same
      file never clears the flag; a manager confirming the new COGS does.

   Pure, so both backends and the client share it.
   ============================================================ */

import { grp, pct } from "./format.js";

/**
 * Also written as `0.5 * cogs` in the reference triggers (migrations/0009_cogs_sanity.sql,
 * copied in server/db.ts). Change all three together; cogsCheck.test.ts fails if they differ.
 */
export const COGS_JUMP = 0.5;

export interface CogsFacts {
  cogs: number;
  list_price: number;
}

export function cogsProblem(item: CogsFacts, reference?: number | null): string | null {
  const cogs = Number(item.cogs) || 0;
  if (!(cogs > 0)) return "COGS kosong di katalog";
  const list = Number(item.list_price) || 0;
  if (list > 0 && cogs > list) {
    return `COGS Rp ${grp(cogs)} lebih tinggi dari harga jual katalog Rp ${grp(list)}`;
  }
  const ref = Number(reference) || 0;
  if (ref > 0 && Math.abs(cogs - ref) > COGS_JUMP * ref) {
    return `COGS Rp ${grp(cogs)} berubah ${pct(Math.abs(cogs - ref) / ref, 0)} dari COGS acuan Rp ${grp(ref)}; perlu dicek manajer`;
  }
  return null;
}
