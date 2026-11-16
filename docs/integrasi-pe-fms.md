# Kontrak integrasi Pricing Engine (PE) dan FMS Salvator

Dokumen ini harus **sama persis** di repo Pricing Engine dan repo FMS Salvator, begitu pula folder `contract-fixtures/`. Tes kontrak di kedua sisi membaca fixture itu. Mengubah kontrak berarti mengubah kedua repo dalam PR berpasangan. Sumber: RENCANA-SO-FMS-2026-11-16, bagian F2.

## 1. Transport

- HTTPS POST, `Content-Type: application/json`, body paling besar 256 KB (262144 byte). Lebih besar ditolak dengan 413.
- Tanda tangan: HMAC-SHA256, hasil heksadesimal huruf kecil, atas string `${epochDetik}.${rawBody}`. `rawBody` adalah byte body persis seperti dikirim. `epochDetik` adalah bilangan bulat detik Unix (bukan milidetik, bukan ISO).

| Arah | Header waktu | Header tanda tangan | Secret |
|---|---|---|---|
| PE ke FMS | `x-pe-timestamp` | `x-pe-signature` | `PE_FMS_SECRET` |
| FMS ke PE | `x-fms-timestamp` | `x-fms-signature` | `FMS_PE_SECRET` |

- Dua secret berbeda, masing-masing paling sedikit 32 karakter. Secret yang belum diset atau lebih pendek dari 32 karakter membuat penerima gagal tertutup (5xx, bukan menerima).
- Kedua header wajib. Header waktu yang hilang atau bukan bilangan bulat ditolak (401).
- Penerima menolak selisih waktu lebih dari 300 detik (401) dan membandingkan tanda tangan secara constant-time. Tanda tangan dengan panjang atau format salah ditolak (401), tidak boleh membuat penerima melempar galat.
- URL wajib HTTPS kecuali host `localhost` atau `127.0.0.1` (dev). Redirect tidak diikuti (`redirect: "manual"`).
- Vektor tanda tangan baku: `contract-fixtures/signature-vector.json`. Kedua sisi wajib menghasilkan `signature` yang sama dari `secret`, `timestamp`, dan `rawBody` di berkas itu.

## 2. Amplop event

```json
{
  "v": 1,
  "eventId": "uuid",
  "sequence": 42,
  "type": "sales_order.created",
  "occurredAt": "2026-11-16T15:40:00Z",
  "payload": { }
}
```

- `v` selalu `1`. `eventId` UUID. `sequence` bilangan bulat positif yang naik per pengirim. `occurredAt` waktu ISO-8601 UTC. `type` salah satu dari bagian 4 dan 5.
- Penerima menyimpan `eventId` yang sudah diproses (idempoten). FMS memakai tabel `pe_inbox`.

## 3. Balasan (ack)

HTTP 200 dengan `{"received": true, "duplicate": <bool>, "applied": <bool>, "reason": "<opsional>"}`.

- `duplicate: true`: `eventId` pernah diterima. Pengirim menganggap terkirim. `applied` mengulang hasil pemrosesan pertama.
- `applied: false` dengan `reason`: diterima tetapi tidak dijalankan (mis. batal ditolak karena sudah diserahkan). Pengirim menganggap terkirim dan menampilkan alasannya.
- 400, 413, 422: permanen. Pengirim memarkir event (tidak dicoba lagi otomatis) dan menampilkannya sebagai gagal. Dipakai untuk JSON rusak, skema tidak sah, body terlalu besar, `soNumber` sama dengan `eventId` berbeda (422).
- 401: tanda tangan, header waktu, atau selisih waktu salah. Permanen, memunculkan peringatan admin (biasanya secret beda).
- 503 (saklar mati) dan 5xx lain, timeout, jaringan: dicoba ulang dengan backoff.

## 4. Event PE ke FMS

### `sales_order.created`

```json
{
  "soNumber": "HK/SIP/SO/2611/001",
  "quoteNumber": "HK/SIP/Q/2611/014",
  "quoteRevNo": 2,
  "entity": "PT",
  "customerPoNumber": "PO-123/XI/2026",
  "client": { "code": "C001", "name": "PT Contoh" },
  "shipTo": { "name": "Bu Rina", "phone": "08xx", "address": "Jl. ..." },
  "requestedDate": "2026-11-20",
  "note": "Kirim pagi",
  "lines": [
    { "lineNo": 1, "sku": "ATK-001", "name": "Kertas A4 80gsm", "uom": "Rim", "qty": 10, "baseUom": "Pcs", "baseQty": null }
  ]
}
```

- Tanpa harga, COGS, atau margin. Data harga tidak boleh keluar dari PE.
- `soNumber`, `quoteNumber`, `entity`, `client.code`, `client.name`, `shipTo.name`, `shipTo.address` wajib tidak kosong. `quoteRevNo` bilangan bulat 0 atau lebih.
- `customerPoNumber`, `requestedDate` (`YYYY-MM-DD`), `note` boleh `null`. `shipTo.phone` boleh string kosong.
- `lines` minimal 1. Tiap baris: `lineNo` bilangan bulat positif dan unik, `sku` tidak kosong, `name` tidak kosong, `uom` tidak kosong, `qty` bilangan bulat lebih dari 0 (satuan `uom` baris quotation; gudang menyimpan jumlah utuh), `baseUom` dan `baseQty` boleh `null`. `baseQty` (bila ada) bilangan lebih dari 0 dalam `baseUom`, informatif saja.
- Gudang memakai `qty` dan `uom` apa adanya. Gudang tidak menghitung ulang dari `baseQty`.

### `sales_order.cancel_requested`

```json
{ "soNumber": "HK/SIP/SO/2611/001", "reason": "Klien membatalkan PO" }
```

FMS menjalankan pembatalan outbound bila status masih mengizinkan (sampai `HANDING_OVER`). Bila tidak, ack `applied: false, reason: "sudah diserahkan"`. `soNumber` yang belum dikenal FMS: ack `applied: false` dengan `reason: "SO tidak dikenal"`.

## 5. Event FMS ke PE

### `outbound.state_changed`

```json
{
  "soNumber": "HK/SIP/SO/2611/001",
  "outboundRef": "DO-...",
  "prevState": "PACKING",
  "state": "AWAITING_HANDOVER",
  "reason": null,
  "courier": null,
  "tracking": null,
  "manifestNo": null
}
```

Dikirim hanya untuk shipment ber-`source = 'PRICING_ENGINE'`. `prevState` dan `state` salah satu status FMS di tabel berikut. `reason`, `courier`, `tracking`, `manifestNo` boleh `null`.

| FMS (`SHIPMENT_STATES`) | PE `fulfillment_state` | Label di PE |
|---|---|---|
| `AWAITING_PAYMENT`, `IMPORTED`, `READY_TO_PACK` | `queued` | Antre di gudang |
| `PACKING`, `RECHECK` | `packing` | Sedang dipacking |
| `TUNDA`, `WAITING_SPV`, `ACTION_REQUIRED`, `FULFILLMENT_SPLIT` | `on_hold` | Tertahan (alasan dari `reason`) |
| `AWAITING_HANDOVER`, `HANDING_OVER` | `packed` | Siap kirim |
| `HANDED_OVER` | `shipped` | Sudah diserahkan |
| `CANCELLED` | `cancelled` | Dibatalkan gudang |

Pemetaan ini satu fungsi di PE (`shared/fmsState.ts`) dengan tes tabel.

## 6. Fixture

`contract-fixtures/valid-*.json` wajib lolos, `invalid-*.json` wajib ditolak oleh validator penerima. `valid-ack-*` dan `invalid-ack-*` berlaku untuk balasan (bagian 3). Pengirim memakai `type` di berkas untuk memilih skema.

## 7. Belum termasuk

Sinkron master barang dan klien (F4b) belum didefinisikan di dokumen ini. Ditambahkan saat F4b dikerjakan, di kedua repo.
