/* ============================================================
   Kontrak integrasi Pricing Engine <-> FMS Salvator (docs/integrasi-pe-fms.md).
   Skema di sini dipakai pengirim (PE memeriksa amplopnya sendiri sebelum
   masuk outbox) dan penerima (event dari FMS). Fixture contoh ada di
   contract-fixtures/ dan sama persis dengan salinan di repo FMS.
   ============================================================ */

import { z } from "zod";

export const CONTRACT_VERSION = 1;

/** Status shipment FMS (SHIPMENT_STATES), lihat tabel di shared/fmsState.ts. */
export const FMS_STATES = [
  "AWAITING_PAYMENT",
  "IMPORTED",
  "READY_TO_PACK",
  "PACKING",
  "RECHECK",
  "TUNDA",
  "WAITING_SPV",
  "ACTION_REQUIRED",
  "FULFILLMENT_SPLIT",
  "AWAITING_HANDOVER",
  "HANDING_OVER",
  "HANDED_OVER",
  "CANCELLED",
] as const;
export type FmsState = (typeof FMS_STATES)[number];

const text = z.string().trim().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus YYYY-MM-DD");

export const soLineSchema = z.object({
  lineNo: z.number().int().positive(),
  sku: text,
  name: text,
  uom: text,
  // Gudang menyimpan jumlah utuh dalam satuan baris.
  qty: z.number().int().positive(),
  baseUom: z.string().min(1).nullable(),
  baseQty: z.number().positive().nullable(),
});
export type SoLine = z.infer<typeof soLineSchema>;

export const salesOrderCreatedSchema = z.object({
  soNumber: text,
  quoteNumber: text,
  quoteRevNo: z.number().int().min(0),
  entity: text,
  customerPoNumber: z.string().nullable(),
  client: z.object({ code: text, name: text }),
  shipTo: z.object({ name: text, phone: z.string(), address: text }),
  requestedDate: isoDate.nullable(),
  note: z.string().nullable(),
  lines: z
    .array(soLineSchema)
    .min(1)
    .refine((lines) => new Set(lines.map((l) => l.lineNo)).size === lines.length, "lineNo harus unik"),
});
export type SalesOrderCreated = z.infer<typeof salesOrderCreatedSchema>;

export const salesOrderCancelSchema = z.object({ soNumber: text, reason: text });
export type SalesOrderCancel = z.infer<typeof salesOrderCancelSchema>;

export const outboundStateChangedSchema = z.object({
  soNumber: text,
  outboundRef: text,
  prevState: z.enum(FMS_STATES),
  state: z.enum(FMS_STATES),
  reason: z.string().nullable(),
  courier: z.string().nullable(),
  tracking: z.string().nullable(),
  manifestNo: z.string().nullable(),
});
export type OutboundStateChanged = z.infer<typeof outboundStateChangedSchema>;

const envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    v: z.literal(CONTRACT_VERSION),
    eventId: z.string().uuid(),
    sequence: z.number().int().positive(),
    type: z.literal(type),
    occurredAt: z.string().datetime(),
    payload,
  });

export const salesOrderCreatedEvent = envelope("sales_order.created", salesOrderCreatedSchema);
export const salesOrderCancelEvent = envelope("sales_order.cancel_requested", salesOrderCancelSchema);
export const outboundStateChangedEvent = envelope("outbound.state_changed", outboundStateChangedSchema);

/** Semua event PE -> FMS. */
export const peEventSchema = z.discriminatedUnion("type", [salesOrderCreatedEvent, salesOrderCancelEvent]);
export type PeEvent = z.infer<typeof peEventSchema>;
export type PeEventType = PeEvent["type"];

/** Semua event yang dikenal kontrak, untuk tes fixture. */
export const anyEventSchema = z.discriminatedUnion("type", [salesOrderCreatedEvent, salesOrderCancelEvent, outboundStateChangedEvent]);

export const ackSchema = z.object({
  received: z.literal(true),
  duplicate: z.boolean(),
  applied: z.boolean(),
  reason: z.string().optional(),
});
export type Ack = z.infer<typeof ackSchema>;

/** F4b: halaman GET /api/integrations/fms/catalog dan /clients (docs bagian 7). */
const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "updated_at harus ISO UTC");
export const catalogPageSchema = z.object({
  items: z.array(z.object({ code: text, name: text, uom: text, category: z.string().nullable(), updated_at: isoUtc }).strict()),
  uoms: z.array(z.object({ code: text, uom: text, factor: z.number().positive() }).strict()),
  nextCursor: z.string().nullable(),
}).strict();
export const clientsPageSchema = z.object({
  clients: z.array(z.object({
    code: z.string().nullable(), name: text, address: z.string().nullable(),
    contact_name: z.string().nullable(), contact_phone: z.string().nullable(), updated_at: isoUtc,
  }).strict()),
  nextCursor: z.string().nullable(),
}).strict();

/** ISO-8601 UTC tanpa milidetik, bentuk `occurredAt` di contoh kontrak. */
export const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");
