# Kontrak Integrasi Pricing Engine (PE) ↔ Fulfillment Management System (FMS) Salvator

Dokumen ini mendefinisikan kontrak antarmuka integrasi dua arah antara **Pricing Engine Salvator** dan **FMS Salvator**. Kedua sistem wajib mematuhi spesifikasi ini.

---

## 1. Arsitektur Komunikasi & Keamanan Webhook

Komunikasi antar-layanan menggunakan HTTP POST Webhook dengan penandatanganan payload kriptografis (HMAC SHA-256) serta mekanisme *outbox & inbox pattern* untuk menjamin pengiriman andal (*at-least-once delivery*) dan pemrosesan idempoten.

### 1.1 Header Webhook Wajib

Setiap request webhook wajib menyertakan HTTP headers berikut:

| Header | Tipe | Deskripsi | Contoh |
| :--- | :--- | :--- | :--- |
| `Content-Type` | String | Format payload (selalu JSON) | `application/json` |
| `X-Signature-SHA256` | String | Signature hex HMAC-SHA256 dari raw body | `a3f5b7...` |
| `X-Timestamp` | String | Waktu pembuatan request (ISO-8601 atau Unix ms) | `2026-11-17T00:30:00.000Z` |
| `X-Event-Id` | String | UUID unik untuk identifikasi pesan idempoten | `evt_so_01jd7q9m8...` |
| `X-Event-Type` | String | Tipe event yang dikirimkan | `sales_order.created` |

### 1.2 Verifikasi Tanda Tangan (Signature Verification)

1. Hitung HMAC-SHA256 dari string mentah body request (`raw_body`) menggunakan secret key bersama (`PE_WEBHOOK_SECRET` atau `FMS_WEBHOOK_SECRET`).
2. Bandingkan hasil dengan nilai header `X-Signature-SHA256` menggunakan perbandingan *timing-safe* (`crypto.timingSafeEqual`).
3. Validasi drift timestamp: jika `abs(now - timestamp) > 300 detik` (5 menit), request wajib ditolak dengan HTTP 401/400.

Contoh validasi (Node.js / Edge Runtime):
```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

### 1.3 Idempotensi & Penanganan Duplikat

- Penerima mencatat `event_id` pada tabel inbox (`pe_inbox` di FMS, `fms_inbox` di PE).
- Jika `event_id` sudah pernah diproses, penerima langsung mengembalikan HTTP 200 `{ ok: true, duplicate: true }` tanpa mengeksekusi ulang efek samping.

### 1.4 Kebijakan Retry & Exponential Backoff

Pengirim menggunakan tabel outbox (`so_outbox` di PE, `fms_pe_outbox` di FMS). Jika panggilan webhook gagal (jaringan terputus / HTTP >= 500):
- Upaya 1: jeda 1 menit
- Upaya 2: jeda 5 menit
- Upaya 3: jeda 15 menit
- Upaya 4: jeda 1 jam
- Upaya 5: jeda 6 jam
- Upaya 6: jeda 24 jam
- Maksimal 6 percobaan. Setelah itu ditandai dead-letter untuk investigasi operator.

---

## 2. Event Payload Schemas

### 2.1 `sales_order.created` (PE → FMS)

Dikirim oleh Pricing Engine saat Sales Order dibuat dari Quotation yang disetujui.

```json
{
  "eventId": "evt_so_create_20261117_0001",
  "eventType": "sales_order.created",
  "occurredAt": "2026-11-17T00:30:00.000Z",
  "payload": {
    "orderNo": "SO-2026-0001",
    "quoteId": "Q-2026-11-001",
    "clientCode": "CLI-MEGA",
    "clientName": "PT Mega Pratama Logistik",
    "orderedAt": "2026-11-17T00:25:00.000Z",
    "items": [
      {
        "sku": "SLV-001-BLK",
        "name": "Salvator Oxford Black 42",
        "qty": 50,
        "uom": "Pcs",
        "notes": "Grade A QC"
      }
    ],
    "shipping": {
      "recipientName": "Budi Santoso",
      "phone": "081234567890",
      "address": "Kawasan Industri Sentul Kav 12",
      "city": "Bogor",
      "postalCode": "16810",
      "courierCode": "SPX",
      "serviceLevel": "STANDARD",
      "notes": "Pintu barat gudang B"
    },
    "metadata": {
      "salesPerson": "Sarah Sales",
      "paymentTerms": "TOP 30"
    }
  }
}
```

### 2.2 `sales_order.cancelled` (PE → FMS)

Dikirim saat Sales Order dibatalkan dari Pricing Engine.

```json
{
  "eventId": "evt_so_cancel_20261117_0002",
  "eventType": "sales_order.cancelled",
  "occurredAt": "2026-11-17T01:00:00.000Z",
  "payload": {
    "orderNo": "SO-2026-0001",
    "reason": "Permintaan pembatalan klien (anggaran dibekukan)",
    "cancelledAt": "2026-11-17T01:00:00.000Z",
    "actor": "sarah.sales"
  }
}
```

*Catatan Bisnis FMS:* Pembatalan hanya dapat dieksekusi jika status paket di gudang masih `READY_TO_PACK` atau `TUNDA`. Jika sudah dalam proses `PACKING` atau `AWAITING_HANDOVER`, status dipindahkan ke `HOLD` untuk intervensi fisik supervisor gudang. Jika sudah `HANDED_OVER`, pembatalan ditolak.

### 2.3 `outbound.state_changed` (FMS → PE)

Dikirim oleh FMS ke webhook PE (`POST /api/webhooks/fms`) setiap kali status pemenuhan pesanan berubah.

```json
{
  "eventId": "evt_fms_out_20261117_0003",
  "eventType": "outbound.state_changed",
  "occurredAt": "2026-11-17T03:15:00.000Z",
  "payload": {
    "orderNo": "SO-2026-0001",
    "previousState": "READY_TO_PACK",
    "newState": "PACKING",
    "changedAt": "2026-11-17T03:15:00.000Z",
    "trackingNo": "SPXID048194819",
    "courierCode": "SPX",
    "handoverBatchId": null,
    "actor": "operator_gudang_1",
    "notes": "Mulai scan packing meja 2"
  }
}
```

---

## 3. Sinkronisasi Master Data (PE → FMS)

Pricing Engine bertindak sebagai *Single Source of Truth* untuk Master Barang (Katalog) dan Master Klien.

### 3.1 Endpoint Ekspor Katalog: `GET /api/catalog/export-fms`
- **Autentikasi:** Header `Authorization: Bearer <FMS_SYNC_TOKEN>` atau `X-Signature-SHA256`.
- **Response Format:**
```json
{
  "ok": true,
  "timestamp": "2026-11-17T00:00:00.000Z",
  "products": [
    {
      "sku": "SLV-001-BLK",
      "name": "Salvator Oxford Black 42",
      "category": "Shoes",
      "brand": "Salvator",
      "uom": "Pcs",
      "active": true
    }
  ]
}
```

### 3.2 Endpoint Ekspor Klien: `GET /api/clients/export-fms`
- **Autentikasi:** Header `Authorization: Bearer <FMS_SYNC_TOKEN>` atau `X-Signature-SHA256`.
- **Response Format:**
```json
{
  "ok": true,
  "timestamp": "2026-11-17T00:00:00.000Z",
  "clients": [
    {
      "clientCode": "CLI-MEGA",
      "name": "PT Mega Pratama Logistik",
      "phone": "081234567890",
      "address": "Kawasan Industri Sentul Kav 12",
      "city": "Bogor",
      "active": true
    }
  ]
}
```

---

## 4. Pemetaan Status (State Mapping Matrix)

| Status Sales Order (PE) | State Outbound (FMS) | Label Pengguna di PE | Label Pengguna di FMS | Keterangan |
| :--- | :--- | :--- | :--- | :--- |
| `DRAFT` | *(belum ada)* | Draf SO | — | SO baru dibuat dari Quotation |
| `CONFIRMED` | `READY_TO_PACK` | Terbit ke Gudang | Siap Dipacking | Diterima gudang, antre checking |
| `PROCESSING` | `PACKING` | Sedang Dipacking | Sedang Dipacking | Operator memeriksa barcode barang |
| `PACKED` | `AWAITING_HANDOVER` | Selesai Dipacking | Menunggu Kurir | Kardus ditutup & label resi terpasang |
| `SHIPPED` | `HANDED_OVER` | Terkirim / Diserahkan | Sudah Diserahkan | Sesi serah terima kurir ditutup |
| `ON_HOLD` | `HOLD` / `TUNDA` | Tertahan Gudang | Tunda | Selisih stok, barang cacat, kendala alamat |
| `CANCELLED` | `CANCELLED` | Dibatalkan | Batal | Dibatalkan oleh sales atau sistem |

---

## 5. Ringkasan Endpoint

| Pengirim | Penerima | Metode | Endpoint | Tipe Event / Fungsi |
| :--- | :--- | :--- | :--- | :--- |
| Pricing Engine | FMS | `POST` | `/api/webhooks/pricing-engine` | `sales_order.created`, `sales_order.cancelled` |
| FMS | Pricing Engine | `POST` | `/api/webhooks/fms` | `outbound.state_changed` |
| FMS (Pull) | Pricing Engine | `GET` | `/api/catalog/export-fms` | Sinkronisasi Master Produk |
| FMS (Pull) | Pricing Engine | `GET` | `/api/clients/export-fms` | Sinkronisasi Master Klien |
