/* ============================================================
   Sales Order Domain Model — Integrasi Pricing Engine & FMS
   ============================================================ */

export type SalesOrderStatus =
  | "DRAFT"
  | "CONFIRMED"
  | "PROCESSING"
  | "PACKED"
  | "SHIPPED"
  | "DELIVERED"
  | "ON_HOLD"
  | "CANCELLED";

export const SO_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  DRAFT: "Draf SO",
  CONFIRMED: "Terbit ke Gudang",
  PROCESSING: "Sedang Dipacking",
  PACKED: "Menunggu Kurir",
  SHIPPED: "Terkirim",
  DELIVERED: "Selesai Diterima",
  ON_HOLD: "Tertahan Gudang",
  CANCELLED: "Dibatalkan",
};

export const SO_STATUS_BADGE_TONE: Record<SalesOrderStatus, "netral" | "sukses" | "awas" | "gagal" | "info"> = {
  DRAFT: "netral",
  CONFIRMED: "info",
  PROCESSING: "awas",
  PACKED: "info",
  SHIPPED: "sukses",
  DELIVERED: "sukses",
  ON_HOLD: "awas",
  CANCELLED: "gagal",
};

export interface SalesOrderItem {
  sku: string;
  name: string;
  qty: number;
  uom: string;
  price: number;
  cogs: number;
  subtotal: number;
  notes?: string;
}

export interface SalesOrderShipping {
  recipientName: string;
  phone: string;
  address: string;
  city: string;
  postalCode?: string;
  courierCode?: string;
  serviceLevel?: string;
  notes?: string;
}

export interface SalesOrder {
  id: string;
  orderNo: string;
  quoteId: number;
  quoteNumber: string;
  clientCode: string;
  clientName: string;
  status: SalesOrderStatus;
  items: SalesOrderItem[];
  shipping: SalesOrderShipping;
  trackingNo: string | null;
  courierCode: string | null;
  totalAmount: number;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  shippedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface SalesOrderEvent {
  id: string;
  orderNo: string;
  eventType: string;
  payload: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

export function canCancelSo(status: SalesOrderStatus): boolean {
  return status !== "SHIPPED" && status !== "DELIVERED" && status !== "CANCELLED";
}

/** Format nomor Sales Order bulanan: SO-YYMM-XXXX (contoh: SO-2611-0001) */
export function formatSalesOrderNo(sequence: number, now = new Date()): string {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const num = String(sequence).padStart(4, "0");
  return `SO-${yy}${mm}-${num}`;
}

/** Pemetaan status FMS ke Sales Order PE */
export function mapFmsStateToSoStatus(fmsState: string): SalesOrderStatus | null {
  switch (fmsState) {
    case "READY_TO_PACK":
      return "CONFIRMED";
    case "PACKING":
      return "PROCESSING";
    case "AWAITING_HANDOVER":
      return "PACKED";
    case "HANDED_OVER":
      return "SHIPPED";
    case "HOLD":
    case "TUNDA":
      return "ON_HOLD";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return null;
  }
}
