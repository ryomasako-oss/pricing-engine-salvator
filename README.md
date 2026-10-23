# Pricing Engine Salvator

Mesin harga dan quotation B2B untuk **PT Salvator Inti Pratama**. Satu aplikasi
untuk menyusun penawaran kontrak ATK: menarik harga pokok dari data Accurate,
menghitung tiga skenario harga sekaligus, menahan penawaran yang melanggar
kebijakan margin sampai disetujui manajer, lalu mengeluarkan PDF dan Excel yang
siap dikirim.

---

## Apa yang dikerjakan aplikasi ini

**Tiga skenario harga, dihitung bersamaan untuk setiap item**

| Skenario | Aturan |
|---|---|
| **S1 Full Margin** | Cost-plus di semua item, dibatasi plafon harga klien (RRP). |
| **S2 Cross Subsidise** | Item *leader* (yang dibanding-bandingkan klien) dijual tipis, ditutup item *profit*. |
| **S3 RRP Discount** | Diskon rata dari RRP, ditahan oleh batas margin minimum. |

Rumus intinya:

```
landed cost = COGS x (1 + opex + logistik bila dinyalakan)
target price = landed cost / (1 - target margin)
```

Harga akhir tidak pernah melewati RRP. Harga manual boleh mengunci satu baris,
tetapi tetap dibatasi RRP dan tetap dihitung marginnya.

**Kepatuhan dan persetujuan.** Setiap quotation diuji terhadap kebijakan harga:
net margin minimum, margin minimum per item, batas diskon basket, larangan jual
di bawah modal, dan ambang nilai yang wajib disetujui. Pelanggaran memblokir
persetujuan otomatis dan melempar penawaran ke antrean manajer. Penolakan wajib
disertai alasan. Setiap perubahan status tercatat di jejak audit.

**Data nyata, bukan angka contoh.** Harga pokok diimpor dari laporan *Nilai
Persediaan* Accurate (COGS per unit = nilai barang masuk ÷ kuantitas barang
masuk), harga jual acuan dari *Daftar Barang dan Jasa*. Daftar permintaan klien
bisa diimpor dari Excel atau CSV apa adanya, termasuk yang plafonnya ditulis
per kota.

---

## Menjalankan di komputer sendiri

Butuh **Node.js 22.5 atau lebih baru**. Backend-nya Worker Cloudflare yang sama
dengan produksi, dijalankan lokal oleh `wrangler dev` (workerd + D1 lokal di
`.wrangler/state`).

```bash
npm install
npm run d1:seed:local   # migrasi D1 lokal, .dev.vars, admin pertama (sekali saja)
npm run dev
```

- Aplikasi: <http://localhost:5173>
- API: <http://localhost:8787/api>

`d1:seed:local` membuat satu akun administrator dan **mencetak kata sandinya
sekali di terminal**. Simpan saat itu juga, atau tentukan sendiri:
`ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run d1:seed:local`. Secret lain (Silvy,
Gemini) diisi di `.dev.vars`; contohnya di `.dev.vars.example`.

## Produksi

Produksi adalah Cloudflare Worker `halokantor-pricing` dengan D1
`halokantor-pricing` (lihat `wrangler.toml`).

```bash
npm run d1:migrate:remote   # bila ada migrasi baru, sebelum deploy
npx vite build
npx wrangler deploy          # tanpa flag tambahan
```

Secret dipasang dengan `wrangler secret put` (JWT_SECRET, Silvy, Gemini, Gmail,
Twilio, Accurate), tidak pernah di-commit.

---

## Sinkron Accurate Online

Worker menarik data dari Accurate lewat **API Token** (hanya baca, tidak pernah
menulis ke Accurate) untuk dua Data Usaha: **CV** dan **PT**.

1. Di tiap Data Usaha (CV dan PT): *Pengaturan → Accurate Store → Aplikasi Saya →
   Install Aplikasi* pakai App Key aplikasi "pricing engine salvator", lalu
   *Accurate Store → API Token → Buat API Token*.
2. Pasang secret (jangan pernah di-commit):
   ```bash
   wrangler secret put ACCURATE_SIGNATURE_SECRET
   wrangler secret put ACCURATE_TOKEN_CV
   wrangler secret put ACCURATE_TOKEN_PT
   npm run d1:migrate:remote        # tabel staging 0011_accurate_sync.sql
   ```
3. Admin cek koneksi: `GET /api/accurate/probe?entity=CV` (mengembalikan 2 baris
   barang dan 1 baris stok mentah untuk memastikan nama field).

Alurnya:

- **Cron tiap 5 menit** memajukan kursor sinkron (maks. `ACCURATE_CALLS_PER_TICK`
  panggilan per tick, batas Accurate 8/detik dipatuhi). Satu putaran penuh:
  barang & harga jual → gudang → stok per gudang. Putaran baru tiap
  `ACCURATE_SYNC_EVERY_HOURS` jam. Barang yang dihapus di Accurate ikut dibersihkan.
- Data masuk ke tabel **staging** (`accurate_items`, `accurate_stock`,
  `accurate_warehouses`), terpisah per entitas, belum menyentuh katalog.
- **Penanda kualitas data** (`GET /api/accurate/flags`): stok minus, kode yang
  sama di CV dan PT tapi beda nama/harga/satuan, nama sama dengan kode beda,
  barang tanpa harga jual.
- **Terapkan ke katalog** (`POST /api/accurate/apply`) menyalin nama, satuan +
  rasio, harga jual acuan, dan total stok. **Hanya data PT** yang diterapkan
  (`ACCURATE_CATALOG_ENTITY`); data CV, bila tokennya dipasang, hanya dipakai
  untuk pengecekan silang. COGS tidak disentuh; tetap dari laporan Nilai
  Persediaan.
- **Paket Workers gratis**: batas 50 subrequest per eksekusi (query D1 ikut
  dihitung), jadi `ACCURATE_CALLS_PER_TICK = 5`; satu putaran ~30.000 barang
  makan sekitar 5 jam. Naikkan setelah pindah ke paket berbayar
  (`accurate.test.ts` menjaga batasnya). Pasang token PT saja dulu supaya
  jatahnya tidak terbagi dua.

Semua tombolnya ada di halaman Katalog (peran manajer ke atas).

---

## Peran pengguna

| Peran | Bisa melakukan |
|---|---|
| **Sales** (`rep`) | Membuat, mengubah, dan mengajukan quotation miliknya sendiri. |
| **Manajer** (`manager`) | Semua di atas untuk quotation siapa pun, plus menyetujui atau menolak, dan mengimpor katalog. |
| **Admin** (`admin`) | Semua di atas, plus mengatur kebijakan harga, identitas perusahaan, dan pengguna. |

Manajer yang mengajukan penawaran yang tidak melanggar apa pun akan disetujui
otomatis atas namanya sendiri; selain itu, semua penawaran masuk antrean.

## Alur status quotation

```
draft ──ajukan──▶ submitted ──setujui──▶ approved ──kirim──▶ sent ──▶ won / lost
  ▲                    │                                                  │
  └──── buka revisi ───┴──────── tolak ───▶ rejected ─────────────────────┘
```

Quotation yang sudah diajukan atau disetujui **terkunci**. Untuk mengubahnya,
buka revisi baru: versi lama tetap utuh di riwayat dan nomor revisi bertambah.

---

## Susunan kode

```
shared/     Engine harga, kebijakan, tipe, format. Dipakai server dan browser
            supaya keduanya menghitung angka yang persis sama.
  engine.ts       Perhitungan harga (murni, tanpa dependensi)
  policy.ts       Evaluasi kebijakan menjadi daftar pelanggaran
  engine.test.ts  27 pengujian yang mengunci perilaku engine

server/     Logika server yang dipakai Worker (pencocokan, familiarity, draft,
            cek COGS, Silvy, OCR, Gmail), tanpa I/O HTTP
  worker/         Worker Cloudflare: index.ts, auth (PBKDF2 + JWT), routes/,
                  sinkron Accurate (accurate/), cron rekap & digest
migrations/ Skema D1, diterapkan berurutan (lokal dan produksi)
scripts/    Tes skenario API, tes integrasi, seed D1 lokal, shim D1 untuk tes
e2e/        Tes Playwright terhadap wrangler dev (workerd) + D1 lokal

src/        Aplikasi React
  pages/          Dashboard, QuoteEditor, Approvals, Catalog, Clients, Settings
  components/     Tabel item, dokumen penawaran, asisten, komponen harga
  import/         Pembaca berkas Excel/CSV (dijalankan di browser)
  export/         PDF (jsPDF) dan Excel (SheetJS)
```

Berkas Excel dibaca **di browser**; yang dikirim ke server hanya baris hasilnya,
jadi server tidak pernah menerima berkas biner dari pengguna.

## Pengujian

```bash
npm test                  # vitest: unit + route Worker di atas shim D1
npm run typecheck         # klien, server, Worker, tes Worker
npm run test:scenarios    # skenario API terhadap Worker, dibandingkan dengan
                          # scripts/api-scenarios.golden.json
npm run test:integration  # alur submit -> persetujuan
npm run e2e               # Playwright terhadap wrangler dev (workerd)
```

Jawaban skenario yang berubah dengan sengaja diperbarui dengan
`UPDATE_GOLDEN=1 npm run test:scenarios`; periksa diff golden file sebelum
di-commit.

Pengujian importer berjalan terhadap berkas Accurate asli bila ada di folder
`~/Downloads`, dan dilewati otomatis bila tidak.

---

## Silvy (asisten AI)

Silvy hanya menjawab dari angka quotation yang sedang dibuka: rincian item,
asumsi, logistik, dan pelanggaran kebijakan. Ia boleh **mengusulkan** perubahan
(misalnya menaikkan margin leader), tetapi usulan itu ditampilkan dulu sebagai
daftar dan baru diterapkan setelah pengguna menekan **Terapkan**. Engine tetap
satu-satunya penentu harga.

Silvy berjalan di `agent-service/` dengan Gemini. App ini hanya gerbangnya:
ia mengautentikasi user, menolak staff (data berisi COGS), membatasi laju, dan
mencatat audit, lalu meneruskan ke agent lewat `SILVY_URL` dengan rahasia
bersama `SILVY_SHARED_SECRET`. Kunci Gemini hanya ada di agent dan tidak pernah
sampai ke browser atau Worker. Tanpa kedua variabel itu, seluruh aplikasi tetap
berjalan normal dan panel menampilkan keterangan bahwa Silvy belum aktif.
Model diatur di agent lewat `GEMINI_MODEL`.

Kuota pertanyaan dan dokumen dibatasi oleh `SILVY_MONTHLY_LIMIT` (default 3000
untuk semua pengguna per bulan) dan `SILVY_USER_DAILY_LIMIT` (default 150 per
pengguna per hari), mengikuti kalender WIB. Slot kuota dicatat secara atomik
sebelum permintaan diteruskan, sehingga permintaan bersamaan tidak melewati
batas. Percobaan yang gagal atau timeout tetap menghabiskan satu slot karena
model mungkin sudah dipakai. Permintaan yang ditolak oleh validasi, izin,
atau batas laju tidak menghabiskan kuota. Audit penggunaan lama tetap dihitung;
perbaikan ini tidak membutuhkan migrasi database baru.

## Catatan keamanan

- Kata sandi di-hash dengan PBKDF2-SHA256 (WebCrypto, 100.000 putaran, batas
  Workers); hash bcrypt lama tetap bisa masuk dan diganti otomatis. Sesi berupa
  JWT di cookie `httpOnly`, `sameSite=lax`, dan `secure` saat produksi.
- Semua badan permintaan divalidasi dengan Zod sebelum menyentuh basis data.
- Semua kueri memakai pernyataan berparameter.
- Header keamanan (CSP, HSTS, X-Frame-Options, X-Content-Type-Options) dipasang
  oleh Worker untuk setiap respons, termasuk halaman dan aset.
- Rate limit Cloudflare: masuk/sandi 10 per menit, Silvy 20 per menit, seluruh
  API 600 per menit per alamat IP.
- `JWT_SECRET` wajib diisi di produksi; aplikasi menolak berjalan tanpanya.
