-- Penjelasan Jual < Beli (Ryoma, 2026-11-28): tim menjelaskan apa yang sebenarnya terjadi pada satu baris SI yang dijual
-- di bawah harga beli, dan penjelasan itu jadi tugas di "Perlu diperbaiki" (kind 'below_cost', line_id = nomor SI).
-- `detail` = penjelasan orangnya; `context` = fakta baris itu saat dijelaskan (klien, tanggal, harga jual/beli, rugi),
-- karena tugas ini tidak punya quotation untuk dirujuk.
ALTER TABLE fix_tasks ADD COLUMN context TEXT NOT NULL DEFAULT '';
