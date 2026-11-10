-- 2026-11-10: a PI bonus line (100% item discount, totalPrice 0, "beli 20 gratis 1") was stored at its
-- written price, and as the last line it became the item's cost (Artline EK-500S: 5.500/PCS instead of
-- 4.714). The mapper now stores it at 0 and spreads the paid money over paid + bonus units. The PI sync
-- starts over and re-reads every PI; its lines are replaced as each PI is read, so the cost data stays
-- in place meanwhile (unlike 0033, the lines are not deleted). About 3.300 PIs, ~7 hours at 40 calls a tick.
DELETE FROM accurate_purchase_state;
