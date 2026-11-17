-- 2026-11-17 (Ryoma): barang baru dari gudang. Accurate bisa membuat barangnya dengan kode lain
-- dari kode usulan (mis. BARU-0003 menjadi 80801999). Manager menyambungkan pengajuan ke kode itu;
-- barcode dan usulan satuannya pindah ke kode Accurate, dan kode tujuannya dicatat di sini.
ALTER TABLE pending_items ADD COLUMN linked_code TEXT;
