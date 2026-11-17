/* Status shipment FMS -> posisi gudang Sales Order di PE (docs/integrasi-pe-fms.md bagian 5),
   plus label status SO dalam bahasa Indonesia. Satu-satunya tempat pemetaan ini. */

import type { FmsState } from "./fmsContract";

export type FulfillmentState = "queued" | "packing" | "on_hold" | "packed" | "shipped" | "cancelled";
export type SalesOrderStatus = "open" | "cancel_requested" | "cancelled" | "shipped";
export type SyncState = "pending" | "delivered" | "failed";

const MAP: Record<FmsState, FulfillmentState> = {
  AWAITING_PAYMENT: "queued",
  IMPORTED: "queued",
  READY_TO_PACK: "queued",
  PACKING: "packing",
  RECHECK: "queued", // Siap Dipacking Ulang: kembali di antrean Belum Dipacking sampai Collect & Pack.
  TUNDA: "on_hold",
  WAITING_SPV: "on_hold",
  ACTION_REQUIRED: "on_hold",
  FULFILLMENT_SPLIT: "on_hold",
  AWAITING_HANDOVER: "packed",
  HANDING_OVER: "packed",
  HANDED_OVER: "shipped",
  CANCELLED: "cancelled",
};

export const fulfillmentFromFms = (state: FmsState): FulfillmentState => MAP[state];

export const FULFILLMENT_LABEL: Record<FulfillmentState, string> = {
  queued: "Antre di gudang",
  packing: "Sedang dipacking",
  on_hold: "Tertahan",
  packed: "Siap kirim",
  shipped: "Sudah diserahkan",
  cancelled: "Dibatalkan gudang",
};

export const SO_STATUS_LABEL: Record<SalesOrderStatus, string> = {
  open: "Aktif",
  cancel_requested: "Minta batal",
  cancelled: "Dibatalkan",
  shipped: "Terkirim",
};

export const SYNC_LABEL: Record<SyncState, string> = {
  pending: "Menunggu kirim",
  delivered: "Terkirim ke FMS",
  failed: "Gagal kirim",
};
