/* "Barang baru" (Ryoma 2026-10-08): an item that doesn't exist in Accurate
   yet is requested here first, and handed to Accurate afterwards. Accurate
   stays the master for code, unit, price and stock; this only lets a quote
   carry the item meanwhile, as a held line (it is not offered, totalled or
   checked, exactly like a COGS hold) until the catalog has the code.

   Handing over is manual and human: a manager "submits" the request, which
   opens a "Barang baru ke Accurate" task and gives the Accurate admin an
   Excel to copy from. Nothing is written to Accurate by the pricing engine. */

export type PendingStatus = "draft" | "submitted" | "linked" | "cancelled";

export const LIVE_PENDING: PendingStatus[] = ["draft", "submitted"];

/** The "problem" a line with a pending code gets; applyHolds turns it into holdReason "new_item". */
export const PENDING_ITEM_PROBLEM = "Barang baru, menunggu dibuat di Accurate";

/**
 * A line whose request was cancelled (and whose code the catalog doesn't
 * have) stays held as "new_item_cancelled". Released, it would be an ordinary
 * line outside the catalog with COGS 0, which the pricing policy can approve
 * on its own at ~100% margin, for an item nobody is going to create.
 */
export const CANCELLED_ITEM_PROBLEM = "Permintaan barang baru ini dibatalkan, jadi tidak bisa ditawarkan";

/** The hold a "barang baru" problem means, or null for any other (COGS) problem. */
export function pendingHoldReason(problem: string | undefined | null): "new_item" | "new_item_cancelled" | null {
  if (problem === PENDING_ITEM_PROBLEM) return "new_item";
  if (problem === CANCELLED_ITEM_PROBLEM) return "new_item_cancelled";
  return null;
}

/** A "barang baru" problem says nothing about costs, so staff may read it as it is. */
export const isPendingItemProblem = (problem: string | undefined | null): boolean => pendingHoldReason(problem) !== null;

/** What a held line says in documents and badges. */
export const PENDING_BADGE = "Menunggu Accurate";

export const AUTO_CODE_PREFIX = "BARU-";

/** "BARU-0007" and the like are only ever given out by the numbering, never typed. */
export const isAutoCode = (code: string): boolean => /^BARU-\d+$/i.test(code.trim());

export interface PendingItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  proposed_price: number;
  note: string;
  status: PendingStatus;
  requested_by: number | null;
  requested_by_name: string | null;
  created_at: string;
  submitted_at: string | null;
  linked_at: string | null;
}

const idr = (n: number) => new Intl.NumberFormat("id-ID").format(Math.round(n));

/** The text of the task the Accurate admin gets, so the item can be created without asking around. */
export function newItemTaskDetail(it: Pick<PendingItem, "code" | "name" | "uom" | "proposed_price" | "note" | "requested_by_name">): string {
  const price = it.proposed_price > 0 ? ` Perkiraan harga jual Rp ${idr(it.proposed_price)}.` : "";
  const note = it.note ? ` Catatan: ${it.note}.` : "";
  const by = it.requested_by_name ? ` Diminta ${it.requested_by_name}.` : "";
  return (
    `Buat di Accurate dengan kode persis ${it.code}, nama "${it.name}", satuan ${it.uom}.${price}${note}${by} ` +
    `Setelah ada di Accurate, sinkron lalu Terapkan ke katalog (pilih tambahkan barang baru); barisnya otomatis lepas dari tahanan.`
  );
}
