-- 2026-11-09: the first PI lines (stored by 0032's sync for ~15 minutes) took unitPrice / 1,11 and
-- missed the item discount (PI.2025.11.00024: 77.000 instead of Accurate's DPP 69.300). The mapper
-- now uses the line's totalPrice; the PI sync starts over so every line is stored the new way.
DELETE FROM accurate_purchase_lines;
DELETE FROM accurate_purchase_state;
