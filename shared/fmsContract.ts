import { z } from "zod";

export const SalesOrderItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  qty: z.number().int().positive(),
  uom: z.string().default("Pcs"),
  notes: z.string().optional(),
});
export type SalesOrderItem = z.infer<typeof SalesOrderItemSchema>;

export const SalesOrderShippingSchema = z.object({
  recipientName: z.string().min(1),
  phone: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().optional(),
  courierCode: z.string().optional(),
  serviceLevel: z.string().optional(),
  notes: z.string().optional(),
});
export type SalesOrderShipping = z.infer<typeof SalesOrderShippingSchema>;

export const SalesOrderCreatedPayloadSchema = z.object({
  orderNo: z.string().min(1),
  quoteId: z.string().min(1),
  clientCode: z.string().min(1),
  clientName: z.string().min(1),
  orderedAt: z.string(),
  items: z.array(SalesOrderItemSchema).min(1),
  shipping: SalesOrderShippingSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SalesOrderCreatedPayload = z.infer<typeof SalesOrderCreatedPayloadSchema>;

export const SalesOrderCreatedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("sales_order.created"),
  occurredAt: z.string(),
  payload: SalesOrderCreatedPayloadSchema,
});
export type SalesOrderCreatedEvent = z.infer<typeof SalesOrderCreatedEventSchema>;

export const SalesOrderCancelledPayloadSchema = z.object({
  orderNo: z.string().min(1),
  reason: z.string().min(1),
  cancelledAt: z.string(),
  actor: z.string().min(1),
});
export type SalesOrderCancelledPayload = z.infer<typeof SalesOrderCancelledPayloadSchema>;

export const SalesOrderCancelledEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("sales_order.cancelled"),
  occurredAt: z.string(),
  payload: SalesOrderCancelledPayloadSchema,
});
export type SalesOrderCancelledEvent = z.infer<typeof SalesOrderCancelledEventSchema>;

export const OutboundStateChangedPayloadSchema = z.object({
  orderNo: z.string().min(1),
  previousState: z.string().min(1),
  newState: z.string().min(1),
  changedAt: z.string(),
  trackingNo: z.string().nullable().optional(),
  courierCode: z.string().nullable().optional(),
  handoverBatchId: z.string().nullable().optional(),
  actor: z.string().min(1),
  notes: z.string().nullable().optional(),
});
export type OutboundStateChangedPayload = z.infer<typeof OutboundStateChangedPayloadSchema>;

export const OutboundStateChangedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("outbound.state_changed"),
  occurredAt: z.string(),
  payload: OutboundStateChangedPayloadSchema,
});
export type OutboundStateChangedEvent = z.infer<typeof OutboundStateChangedEventSchema>;

export const CatalogExportProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  brand: z.string().optional(),
  uom: z.string().optional(),
  active: z.boolean(),
});

export const CatalogExportResponseSchema = z.object({
  ok: z.boolean(),
  timestamp: z.string(),
  products: z.array(CatalogExportProductSchema),
});
export type CatalogExportResponse = z.infer<typeof CatalogExportResponseSchema>;

export const ClientExportItemSchema = z.object({
  clientCode: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  active: z.boolean(),
});

export const ClientExportResponseSchema = z.object({
  ok: z.boolean(),
  timestamp: z.string(),
  clients: z.array(ClientExportItemSchema),
});
export type ClientExportResponse = z.infer<typeof ClientExportResponseSchema>;
