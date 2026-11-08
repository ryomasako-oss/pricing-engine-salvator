# Standar UI/UX Pricing Engine (v1)

Satu bahasa tampilan untuk semua halaman. Dokumen ini adalah aturan; desain visualnya ada di berkas FigCraft
`PRICING ENGINE DATA HUB/design/pricing-engine-ui-standar.figcraft` (di luar repo), dengan halaman:
00 Panduan · 01 Fondasi · 02 Komponen · 03 Halaman desktop · 04 Modal & status · 05 Mobile.

Status: usulan di cabang `feat/ui-standar`. Kode aplikasi belum diubah; lihat "Rencana penerapan".

## Acuan

| Hal | Acuan | Alasan |
|---|---|---|
| Design system | [IBM Carbon](https://carbondesignsystem.com/) (Apache 2.0) | Paling lengkap untuk aplikasi B2B padat data: tabel 5 ukuran baris, batch action, skeleton, skala spasi 2/4/8 |
| Pembanding kepadatan | [Ant Design](https://ant.design/) (MIT) | Ukuran kontrol small/middle/large |
| Font | [Inter](https://rsms.me/inter/) (SIL OFL) | Gratis, angka tabular (`tnum`), dipakai luas di aplikasi bisnis. IBM Plex Sans juga boleh, tetapi Inter dipilih karena sudah terpasang dan lebih ringkas di tabel |
| Aksesibilitas | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) AA | Teks ≥ 4,5:1 (1.4.3), garis kontrol dan fokus ≥ 3:1 (1.4.11), target sentuh ≥ 24 px (2.5.8) |
| Angka di tabel | [`font-variant-numeric: tabular-nums`](https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric) | Digit sama lebar, kolom angka rata |

Tidak dipakai: Shopify Polaris (lisensinya membatasi pemakaian di luar ekosistem Shopify) dan pedoman Atlassian (dibatasi untuk add-on Atlassian).

## Prinsip

1. **Data dulu.** Angka rata kanan dengan angka tabular, satuan selalu tertulis. Tabel padat (baris 40 px) untuk kerja harian.
2. **Satu arti, satu bentuk.** Satu komponen status (Badge), satu pola konfirmasi (Modal), satu tombol utama per area.
3. **Warna punya peran.** Navy = identitas Salvator (top bar). Biru = bisa diklik. Merah/kuning/hijau = status, selalu disertai teks atau ikon.
4. **Bisa diakses.** Kontras sesuai WCAG AA, fokus selalu terlihat, target sentuh ≥ 24 px (44 px di HP).
5. **Peran menentukan isi.** Sales tidak melihat COGS, margin, asumsi. Tata letak tetap sama; kolom dan aksi muncul sesuai izin.
6. **Bahasa Indonesia baku.** Kata kerja di tombol (Simpan, Ajukan, Hapus klien), bukan "OK" atau "Submit".
7. **Tenang, tanpa ornamen.** Kata dan angka yang bekerja, bukan hiasan. Tidak ada ikon di tombol berlabel, di judul, atau di keadaan kosong; tidak ada kotak per angka; tidak ada garis warna di tepi kiri. Pemisah cukup garis tipis 1 px. Ikon hanya untuk tombol tanpa teks (hapus, tutup, kirim, lihat sandi), panah kembali, chevron menu, dan ikon urut di header tabel. (Masukan pemilik 2026-11-08: ubin dan ikon terasa "buatan AI"; acuan: ringkasan Stripe Dashboard.)

## Token

Kode memakai nama token, tidak boleh hex lepas. Usulan nama CSS: `--color-*`, `--space-*`, `--radius-*`, `--font-*`.

### Warna (mode terang)

Kontras dihitung dengan rumus WCAG.

| Token | Hex | Pakai untuk | Kontras |
|---|---|---|---|
| `bg` | `#F4F4F4` | Latar halaman | |
| `layer` | `#FFFFFF` | Kartu, tabel, modal, input | |
| `hover` | `#E8E8E8` | Hover baris, skeleton | |
| `border` | `#E0E0E0` | Garis pemisah, tepi kartu | dekoratif |
| `border-strong` | `#8D8D8D` | Tepi input, checkbox | 3,3:1 |
| `text` | `#161616` | Teks utama | 18,1:1 |
| `text-2` | `#525252` | Teks sekunder, label | 7,8:1 |
| `placeholder` | `#6F6F6F` | Placeholder | 5,0:1 |
| `brand` | `#1F3A5F` | Top bar, logo, avatar Silvy | putih di atasnya 11,5:1 |
| `brand-soft` | `#2C4A73` | Menu aktif di top bar | |
| `brand-muted` | `#BCC4CF` | Teks menu tidak aktif di top bar | 6,5:1 di atas `brand` |
| `action` | `#0F62FE` | Tombol utama, tautan, fokus, tab aktif | 5,0:1 |
| `action-hover` | `#0353E9` | Hover tombol utama | 6,1:1 |
| `action-soft` | `#EDF5FF` | Baris terpilih, opsi terpilih | |
| `ok` / `ok-text` / `ok-bg` | `#198038` / `#0E6027` / `#DEFBE6` | Sukses, Disetujui, Menang | 5,0 / 7,0:1 |
| `warn` / `warn-text` / `warn-bg` | `#F1C21B` / `#7A5800` / `#FCF4D6` | Peringatan, Menunggu, Ditahan | teks gelap di `warn` 10,8:1; `warn-text` 5,9:1 |
| `err` / `err-text` / `err-bg` | `#DA1E28` / `#A2191F` / `#FFF1F1` | Bahaya, Ditolak, blokir | 5,0 / 7,1:1 |
| `info` / `info-bg` | `#0043CE` / `#EDF5FF` | Info, Terkirim | 7,1:1 |
| `neutral-text` / `neutral-bg` | `#393939` / `#E0E0E0` | Draft, Kalah, label netral | 8,8:1 |
| `purple-text` / `purple-bg` | `#6929C4` / `#F6F2FF` | Selesai, peran Admin | 7,0:1 |

Aturan: tombol `action` tidak boleh langsung di atas `brand` (kontrasnya rendah). Di top bar, tombol memakai gaya `on-brand` (garis `brand-muted`, teks putih).
Mode gelap dibuat sesudah mode terang disetujui, dengan nama token yang sama (menggantikan pasangan token yang ada sekarang di `src/styles.css`).

### Tipografi (Inter)

Hanya 9 gaya. Ukuran lain (saat ini ada 20 ukuran berbeda) dihapus.

| Gaya | Ukuran/tinggi baris | Bobot | Pakai untuk |
|---|---|---|---|
| `display` | 32/40 | SemiBold | Sampul, angka besar |
| `h1` | 24/32 | SemiBold | Judul halaman, satu per halaman |
| `h2` | 18/26 | SemiBold | Judul modal, judul bagian |
| `h3` | 16/24 | SemiBold | Judul kartu |
| `kpi` | 28/36 | SemiBold, `tnum` | Nilai KPI |
| `body-strong` | 14/20 | SemiBold | Label tombol, penekanan |
| `body` | 14/20 | Regular | Teks dasar, isi tabel |
| `label` | 12/16 | Medium | Label field, header tabel, badge |
| `caption` | 12/16 | Regular | Keterangan, bantuan, meta |

Semua angka (harga, qty, persen, tanggal di tabel) memakai `tnum`. Ukuran minimum 12 px; badge 10,5 px dihapus.

### Jarak, bentuk, elevasi

- **Spasi (px):** 2, 4, 8, 12, 16, 24, 32, 40, 48, 64. Tidak ada nilai lain (sekarang ada `marginBottom: 14` dan sejenisnya di sekitar 321 inline style).
- **Radius:** 4 (tombol, input, badge kotak) · 8 (kartu, tabel, modal) · penuh (badge status, avatar, chip). Sekarang ada 14 radius berbeda (2–22 px).
- **Garis:** 1 px `border` untuk pemisah, 1 px `border-strong` untuk kontrol, 2 px `action` untuk fokus dan tab aktif.
- **Elevasi:** level 0 = datar dengan garis (kartu, tabel). Level 1 = `0 8px 24px rgba(0,0,0,.16)` untuk overlay (modal, menu, toast). Tidak ada level lain.

### Ukuran kontrol

| Kontrol | Tinggi |
|---|---|
| Tombol `sm` (tabel, toolbar, kartu) | 32 |
| Tombol/input `md` (default) | 40 |
| Tombol/input `lg` (login, HP) | 48 (input HP 44) |
| Baris tabel | 40 default · 32 compact · 48–56 bila ada dua baris teks |
| Header tabel | 40, lengket saat scroll |
| Top bar | 48 desktop · 56 HP |

### Breakpoint (Carbon)

| Nama | Lebar | Perilaku |
|---|---|---|
| sm | < 672 | Nav jadi menu ☰, tabel jadi daftar kartu (`.table.stack`: sel `stack-title` di atas, `stack-action` di kanan atas, sel lain baris "label  nilai" dari `data-label`; dipakai di Quotation, item Quotation sales, Katalog, Klien), modal layar penuh, Silvy jadi sheet layar penuh, tombol aksi di bawah |
| md | 672–1055 | Editor satu kolom (sidebar turun ke bawah), filter dibungkus |
| lg | 1056–1311 | Nav dipadatkan; menu yang tidak muat masuk "Lainnya" |
| xlg | 1312–1583 | Desktop standar (desain dibuat di 1440) |
| max | ≥ 1584 | Isi tetap penuh, tabel boleh menambah kolom opsional |

Menggantikan breakpoint sekarang: 420, 560, 640, 720, 1080, 1500.

### Format dan bahasa

| Jenis | Benar | Hindari |
|---|---|---|
| Rupiah | `Rp 48.250.000` | `Rp48250000`, `IDR 48,250,000`. KPI boleh ringkas: `Rp 1,24 M`, `Rp 412 jt` |
| Persen | `12,5%` | `12.5 %`, `0.125` |
| Tanggal | `8 Nov 2026`, `8 Nov 2026 10:24`; relatif untuk < 2 hari: `Hari ini`, `Kemarin` | `11/08/2026` (ISO hanya di ekspor data) |
| Jumlah | `10 lusin`, `5 rim` | angka tanpa satuan |
| Kosong | `—` atau "Belum ada …" | `0`, `null` |
| Tombol | kata kerja + objek: "Hapus klien", "Buka sebagai revisi 3" | "OK", "Ya", "Submit" |
| Eror | apa yang terjadi + apa yang harus dilakukan: "Gagal menyimpan. Periksa koneksi lalu coba lagi." | `err.message` mentah dari server |

## Komponen

Satu komponen per kebutuhan. Daftar di bawah menggantikan kelas yang ada sekarang.

| Komponen | Aturan | Menggantikan |
|---|---|---|
| **Button** | Jenis: `primary`, `secondary`, `ghost`, `danger`, `success`, `on-brand`. Ukuran `sm/md/lg`. Satu `primary` per area. Saat proses: label "Menyimpan…" dan nonaktif. Tanpa ikon kecuali tombol ikon-saja (`.icon-btn`) dan chevron menu | `.btn` dengan urutan kelas acak (`btn small ghost` / `btn ghost small`) |
| **Field** | Label di atas, `*` bila wajib, bantuan atau eror di bawah (eror berwarna `err-text` dengan ikon ⚠), tepi `border-strong`. Varian: input, select, textarea, search, suffix (%, Rp) | `.input`, `.select`, `.textarea`, `.field`, `.cell` |
| **Checkbox / Toggle** | Checkbox untuk filter dan pilihan; Toggle untuk pengaturan yang langsung berlaku (Aktif/Nonaktif) | |
| **Badge** | SATU komponen status: titik + teks, pill, nada `neutral/info/ok/warn/err/purple`. Badge tanpa titik untuk hitungan dan alias | `.badge`, `.pill`, `.status-chip`, `.chip` |
| **Menu** | Tombol `secondary` dengan ▾ (ikon), daftar aksi di bawahnya: ikon + label + keterangan `caption`, pemisah antarkelompok, aksi bahaya merah di paling bawah. Escape/klik di luar menutup, panah atas/bawah berpindah | `components/Menu.tsx` |
| **Tabs** | Garis bawah 2 px `action` untuk tab aktif, hitungan di badge netral | `.tabs` |
| **Chip filter** | Pill, terpilih = isi `text` dengan teks putih; bisa lebih dari satu | `.chip` |
| **Table** | Header `layer-2` 40 px lengket; angka rata kanan + `tnum`; aksi baris di kolom kanan (tombol `ghost sm`); baris terpilih `action-soft`; baris bermasalah memakai latar `err-bg`/`warn-bg`; paging di kaki tabel "Menampilkan 1–50 dari N"; sorting dengan ikon di header (bukan ▲/▼ literal) | `.table`, `.table-wrap` |
| **Card** | Latar `layer`, garis `border`, radius 8, padding 16; judul `h3` dengan sub `caption`, aksi `sm` di kanan | `.card`, `.card-head` (judul 12 px kapital dihapus) |
| **KPI** | Satu permukaan dengan pemisah garis tipis antar angka (bukan kartu per angka). Label `label`, nilai `kpi`, catatan `caption` berwarna sesuai nada | `.kpi-grid` > `.kpi` |
| **Banner** | Info tentang halaman atau objek; latar nada lembut saja (tanpa garis kiri, tanpa ikon); boleh satu aksi `ghost` | `.notice` |
| **Toast** | Hasil aksi; gelap (`text`) dengan aksen nada; hilang setelah 5 dtk, eror tetap sampai ditutup dan punya "Coba lagi" | `.hk-toast` |
| **Modal** | Judul `h2` + sub, isi padding 24, kaki abu dengan Batal (kiri) dan aksi utama (kanan). Lebar 560 (normal) / 800 (lebar) / layar penuh di HP. Fokus terkunci, Escape menutup | `.modal`; dan **`window.confirm` dihapus** (`Catalog.tsx:168`, `QuoteEditor.tsx:962`) diganti `ConfirmModal` |
| **Konfirmasi bahaya** | Modal dengan judul pertanyaan ("Hapus PT Graha Medika?"), akibatnya, dan tombol `danger` yang menyebut objek ("Hapus klien") | campuran `window.confirm` / `ConfirmModal` |
| **Empty / Loading / Error** | Kosong: judul + penjelasan + satu aksi. Memuat: skeleton, bukan teks "Memuat…". Eror: apa yang terjadi + "Coba lagi" | teks "Memuat quotation…" |
| **Icon** | Satu set SVG stroke 1,5 px, 16/20 px. Tidak ada glif teks (✔ ⚠ ▲ ▼ ↑ ↓) | semua glif yang tercatat sudah diganti (Katalog, Riwayat COGS, Klien) |
| **Top bar** | Navy 48 px, logo + nama, menu sesuai izin, angka merah untuk tugas, avatar + nama + peran, tombol tema, Keluar (`on-brand`) | `.hk-top`, `.hk-nav` |
| **Silvy** | Desktop: panel kanan 400 px yang tidak menutupi tabel (di editor: di sidebar). HP: sheet layar penuh. Jawaban selalu menyebut sumber angka; perubahan hanya setelah pengguna klik "Terapkan" atau "Tinjau N item". Pemicu: tombol "Tanya Silvy" di kanan bawah | `.chat-fab`, `.chat-dock`, `AssistantPanel` |

## Halaman

Struktur yang sama untuk semua halaman: **Top bar → judul halaman (h1, deskripsi, aksi di kanan) → KPI (bila ada) → banner (bila ada) → kartu isi (tab, toolbar, tabel/daftar, paging)**. Modal untuk aksi yang butuh input.

| Halaman | Rute | Akses | Isi standar (lihat FigCraft "03 Halaman desktop") |
|---|---|---|---|
| Login | `/` belum masuk | publik | Kartu 440 px di tengah (di HP menempel ke atas): logo navy + nama aplikasi + perusahaan, judul "Masuk", email, kata sandi, eror dalam banner `role="alert"` (pesan server yang sudah ramah dipakai; 5xx diganti "Server sedang bermasalah…"), tombol `lg` penuh, "Lupa kata sandi?" membuka modal, catatan akun di bawah |
| Quotation | `/quotes` | semua | Aksi: "Dari list klien", "Quotation baru". "Perlu tindakan" dan "Hasil saya/tim" berbeda per peran (lihat "Tampilan per peran"); net margin hanya `view_costs`. List klien tersimpan + kartu Silvy berdampingan. Tabel dengan tab status + hitungan, cari, "Punya saya"; kolom Nomor, Judul (+rev), Klien, Status, Item, Nilai/bulan, Net margin (merah < batas), Dibuat oleh, Diubah |
| Editor quotation | `/quotes/:id` | `view_costs` | Kembali, judul, meta (nomor, rev, status, klien, item, penugasan). Aksi: Ekspor, Alihkan, Simpan, aksi alur (Ajukan/Putuskan/Tandai terkirim/Menang/Kalah/Tandai selesai). Banner terkunci/ditolak. Grid: kartu Item dengan tab (Item, Penjelasan, Asumsi, Logistik, Dokumen, Riwayat) + Perbandingan skenario; sidebar 380 px: Skenario, Kepatuhan harga, Silvy. Baris bermasalah diberi latar nada |
| Quotation (sales) | `/quotes/:id` | lainnya | Sama dengan editor tanpa COGS, margin, asumsi, skenario. Aksi: Simpan, Ekspor PDF, Ajukan (utama). Kartu Item: "Tambah dari katalog", banner "Butuh persetujuan manajer" tanpa rincian baris/aturan (server sengaja hanya mengirim satu pesan generik supaya COGS tidak bisa ditebak), baris ditahan berlatar kuning. Dokumen penawaran dengan "Lihat dokumen" di kepala kartu. Silvy lewat tombol "Tanya Silvy" |
| Persetujuan | `/approvals` | `decide_quotes` | Muat ulang (`ghost`) di kepala halaman. KPI: Nilai tertahan / bulan (nada warn), Rata-rata tunggu (jam bila < 1 hari), Diputuskan 7 hari terakhir. Tab Menunggu/Disetujui/Ditolak/Semua dengan hitungan (riwayat dibatasi 200 baris server, ditandai "+"). Baris: judul + badge, meta, pelanggaran (garis kiri nada), catatan keputusan; nilai/bulan + net di kanan; "Buka dan putuskan" (utama) untuk yang menunggu, "Buka quotation" untuk yang sudah diputuskan. Di HP satu kolom |
| Perlu diperbaiki | `/perbaikan` | semua | Muat ulang (`ghost`) di kepala halaman. Tab Terbuka (hitungan sama dengan badge top bar) / Selesai. Toolbar: cari (barang, kode, quotation, klien) + chip per jenis dengan hitungan; chip tanpa tugas disembunyikan. Kartu tugas: badge jenis (tidak di katalog = err, COGS/barang baru = warn, satuan = purple, sales/Accurate = info) + umur (merah ≥ 3 hari), barang, meta, detail, langkah perbaikan dengan garis kiri `action`; di tab Selesai: siapa, kapan, catatannya. Aksi Buka quotation (`secondary sm`) / Tandai selesai (`primary sm`, sesuai izin jenis) |
| Pencocokan | `/pencocokan` | semua | Dua kolom (420 px + sisa; satu kolom < 1056 px): kartu "Masukkan daftar" (klien + bantuan, judul feed, drop zone di tengah, tempel, "Cocokkan · N baris" penuh) dan kartu hasil (judul feed + badge jumlah, "Feed baru"; centang "semua klien" khusus `edit_catalog`; banner latihan tanpa klien; chip Semua/Perlu Dibereskan/Sudah Familiar; tabel Teks klien, Status, Pasangan dengan pil kandidat + yakin %). Sebelum ada feed, kartu hasil menampilkan keadaan kosong. Pembelajaran pencocokan di bawah (hanya `import_catalog`) |
| Katalog | `/catalog` | semua | Aksi (hanya `import_catalog`): menu "Impor ▾" (Nilai Persediaan, Daftar Barang dan Jasa, Katalog lengkap gabung, Unduh template, lalu "Ganti seluruh katalog…" merah khusus `delete_catalog` dengan modal konfirmasi), Unggah gambar massal, Tambah barang (utama). 5 KPI, panel Barang baru menunggu Accurate, panel Sinkron Accurate, banner COGS < 60%. Tabel: cari + filter gambar, sorting di header dengan ikon dan `aria-sort`, kaki "Menampilkan 1–50 dari N" + pilih halaman. Kosong karena pencarian: "Hapus pencarian"; katalog kosong: "Impor Nilai Persediaan" |
| Riwayat COGS | `/cogs-history` | `view_costs` | Kembali ke Katalog; Riwayat penjualan (SI) (`ghost`). Toolbar: cari + "Hanya yang beda" + jumlah barang. Kartu per barang: judul + kode/satuan, COGS katalog (merah "kosong"), badge RI terakhir (warn bila ditahan, info bila belum diterapkan), tabel harga beli (Nomor RI, Tanggal, Qty, Harga / satuan, badge "Terbaru" / "Dipakai" dengan ikon), daftar COGS yang pernah diganti. Paging "Halaman x dari y" di bawah. Pemasok belum ada di data, jadi kolomnya belum ditampilkan |
| Riwayat SI | `/sales-history` | `view_costs` | Kembali ke Pencocokan; Riwayat COGS (`ghost`). Toolbar: cari (480 px) + "N barang terjual". Kartu per barang (pola sama dengan Riwayat COGS): alias faktur sebagai badge tanpa titik dengan hitungan, tabel faktur terbaru (Tanggal, Nomor faktur, Customer + tulisan di faktur, Qty, Harga + harga per satuan dasar), "Diretur semua" sebagai badge merah. Paging di bawah |
| Klien | `/clients` | semua (hapus: `delete_clients`) | "Klien baru" (utama). Toolbar: cari nama/kode/PIC + jumlah klien. Tabel nama (+alamat), kode, kontak (+email), termin, jumlah quotation, Ubah (`ghost sm`) + ikon hapus. Hapus lewat modal konfirmasi; pesannya menyebut jumlah quotation yang memakai klien (server menolak bila > 0). Modal ubah: grid field, alamat, template dokumen (kolom dengan ikon naik/turun, bukan glif ↑↓) |
| Pengaturan | `/settings?bagian=…` | sesuai izin | Sub-navigasi kiri 240 px (Kebijakan harga, Identitas dokumen, Password Excel, Notifikasi, Kata sandi saya, Pengguna, Permintaan reset + hitungan merah); satu bagian tampil, dipilih lewat `?bagian=` (baris admin "Permintaan reset sandi" di dasbor membuka `?bagian=reset`). < 1056 px: sub-nav jadi baris geser di atas. Bagian disembunyikan sesuai izin; sales melihat Identitas (hanya baca), Notifikasi, Kata sandi. Field dengan affix (%, Rp). Status pengguna sebagai Badge di samping toggle; peran tetap select karena bisa diubah admin. Simpan di kanan bawah kartu |

Modal standar (FigCraft "04 Modal & status"): Quotation baru, Ekspor quotation (daftar opsi dengan ikon), Putuskan quotation (banner pelanggaran + catatan; Tolak `danger`, Setujui `success`), Konfirmasi hapus.

Mobile (FigCraft "05 Mobile"): daftar quotation sebagai kartu, login, Silvy layar penuh, item quotation sales dengan aksi Simpan/Ajukan di bawah.

## Tampilan per peran

Peran berasal dari `shared/permissions.ts`: **Sales** (`rep`, tanpa izin khusus), **Manajer** (`decide_quotes`, `view_costs`, `edit_catalog`, `import_catalog`, `edit_all_quotes`, `delete_clients`, `view_audit`, `skip_match_review`), **Admin** (semua izin Manajer ditambah `manage_users`, `manage_policy`, `manage_company`, `delete_catalog`, `delete_quotes`). Tampilan memeriksa izin, bukan nama peran, agar peran baru cukup diatur di satu tempat. Server tetap menegakkan izin yang sama; menyembunyikan tombol bukan pengamanan.

### Halaman Quotation (dasbor)

Urutan: judul → panel ringkasan (satu permukaan): kiri **Perlu tindakan** sebagai daftar baris (titik nada kecil, label + keterangan, hitungan rata kanan; baris bernilai 0 diredupkan), kanan **Hasil saya / Hasil tim** sebagai baris angka (label + catatan kiri, angka kanan), dipisah garis tipis → List klien tersimpan + Silvy → tabel. Di bawah 1056 px kedua bagian ditumpuk.

| | Sales | Manajer | Admin |
|---|---|---|---|
| Deskripsi judul | "Quotation yang Anda buat atau ditugaskan ke Anda." | "Ringkasan quotation seluruh tim." | sama dengan Manajer |
| "Punya saya" bawaan | aktif | mati | mati |
| Perlu tindakan | Draft belum diajukan → tab Draft; Ditolak, perlu revisi → tab Ditolak; Perlu diperbaiki → `/perbaikan`; Disetujui, siap dikirim → tab Disetujui; Menunggu manajer → tab Menunggu | Menunggu keputusan Anda → `/approvals`; Perlu diperbaiki → `/perbaikan`; Disetujui, belum dikirim → tab Disetujui | Manajer + Permintaan reset sandi → `/settings` |
| KPI | Pipeline aktif, Nilai dimenangkan, Tingkat menang | + Rata-rata net margin | sama dengan Manajer |
| Kolom tabel | tanpa Net margin | + Net margin (merah di bawah batas) | sama dengan Manajer |

Hitungan di daftar Perlu tindakan diambil dari daftar penuh, bukan hasil pencarian, supaya kata kunci di kotak cari tidak menyembunyikan pekerjaan. Hitungan "Menunggu keputusan" dan "Perlu diperbaiki" memakai endpoint yang sama dengan badge di top bar.

### Navigasi

| Menu | Sales | Manajer | Admin |
|---|---|---|---|
| Quotation, Pencocokan, Perbaikan, Katalog, Klien, Pengaturan | ✓ | ✓ | ✓ |
| Persetujuan (badge jumlah menunggu) | – | ✓ | ✓ |
| Riwayat COGS, Riwayat SI | – | ✓ | ✓ |

Rute yang tidak boleh dibuka menampilkan kartu kosong "Halaman ini khusus manajer dan admin", bukan halaman putih.

### Alur kerja

**Sales**
1. Buat quotation: "Quotation baru", "Dari list klien", atau minta Silvy.
2. Isi item di layar Quotation (sales): tanpa COGS, margin, asumsi, dan skenario (server tidak mengirim datanya).
3. Simpan → **Ajukan**. Bila harga lolos kebijakan, langsung disetujui; bila tidak, menunggu manajer.
4. Ditolak: baca catatan di banner merah → **Buka revisi baru** → perbaiki → ajukan ulang.
5. Disetujui: **Ekspor** PDF → kirim ke klien → **Tandai terkirim** → **Menang** / **Kalah** → **Tandai selesai**.
6. Perbaikan: lihat tugas barang di quotation miliknya; yang menyelesaikan manajer.
7. Pengaturan: nomor HP untuk notifikasi dan chat Silvy lewat Telegram, ganti kata sandi.

**Manajer**
1. Dari baris "Menunggu keputusan Anda" ke Persetujuan → **Buka dan putuskan** → modal Putuskan (pelanggaran + catatan; **Tolak** `danger`, **Setujui** `success`).
2. Editor quotation lengkap: COGS, asumsi, skenario, kepatuhan harga, Silvy di sidebar. Bisa **Alihkan** quotation ke sales lain dan mengedit quotation siapa pun.
3. Perbaikan: selesaikan tugas katalog (barang tidak ada, COGS, satuan, cek silang Accurate) lalu **Tandai selesai**.
4. Katalog, Riwayat COGS, Riwayat SI untuk menjaga harga pokok; impor katalog dan Accurate.
5. Setelah disetujui: **Import cek sales** untuk mencatat barang yang ditolak klien.

**Admin**
1. Semua alur Manajer.
2. Pengaturan: Pengguna (tambah, peran, nonaktif), Permintaan reset sandi, Kebijakan harga, Identitas dokumen, Password Excel.
3. Hapus barang katalog (`delete_catalog`) lewat modal konfirmasi. `delete_quotes` belum punya tombol di UI.

Aksi utama di setiap layar mengikuti langkah berikutnya dalam alur peran itu: satu tombol `primary` (mis. Ajukan untuk Sales di draft, Putuskan untuk Manajer di quotation yang menunggu), sisanya tombol biasa.

## Inkonsistensi yang dibereskan

Ditemukan di kode saat ini (cabang `develop` per 8 Nov 2026):

1. 20 ukuran font berbeda (10–24 px, termasuk 12,5/13,5/14,5) → 9 gaya.
2. 14 radius berbeda → 3.
3. 62 warna hex di `styles.css` dan hex lepas di `QuotationDoc.tsx:93` → token saja.
4. ±321 inline `style={{…}}` dengan margin acak → kelas utilitas spasi atau komponen tata letak.
5. 4 bentuk status (`.badge`, `.pill`, `.status-chip`, `.chip`) → 1 Badge.
6. `window.confirm` vs `ConfirmModal` → hanya Modal.
7. "Ekspor" (editor) vs "PDF" (sales) untuk aksi yang mirip → editor: "Ekspor" membuka modal pilihan; sales: "Ekspor PDF" langsung (satu pilihan tidak perlu modal).
8. Glif teks sebagai ikon → komponen Icon.
9. 6 breakpoint acak → 5 breakpoint Carbon.
10. Judul kartu 12 px kapital vs judul modal 17 px → h3 dan h2.

## Rencana penerapan (usulan, belum diputuskan)

Bertahap supaya produksi aman (setiap tahap lewat PR ke `develop`, lalu `master`):

1. Token: tambah variabel baru di `src/styles.css` (warna, spasi, radius, font) di samping yang lama; pasang Inter.
2. Komponen dasar: Button, Field, Badge, Card, Table, Modal, Banner, Toast, Icon memakai token.
3. Halaman satu per satu, mulai dari yang paling sering dipakai: Quotation, Editor quotation, Quotation sales, Katalog; lalu sisanya.
4. Hapus token dan kelas lama setelah tidak dipakai; mode gelap dengan nama token yang sama.

Setiap tahap: typecheck, tes, cek kontras, dan tangkapan layar sebelum/sesudah.
