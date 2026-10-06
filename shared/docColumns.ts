/* Which price columns the customer-facing quotation shows. A rep can send a
   plain price list (no quantities) or drop the per-line totals; both default
   to shown so existing quotes print exactly as before. */

import type { QuoteMeta } from "./types";

export interface DocColumns {
  qty: boolean;
  lineTotal: boolean;
  /** Subtotal / PPN / contract value. Without a quantity there is nothing to add up, so these go with it. */
  totals: boolean;
}

export function docColumns(meta: Pick<QuoteMeta, "hideQty" | "hideLineTotal">): DocColumns {
  const qty = !meta.hideQty;
  return { qty, lineTotal: qty && !meta.hideLineTotal, totals: qty };
}
