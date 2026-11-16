/* ============================================================
   Pricing Engine — FMS Webhook Receiver Route
   Handles outbound.state_changed events from FMS Salvator.
   ============================================================ */

import { Hono } from "hono";
import type { Env } from "../env";
import { OutboundStateChangedEventSchema } from "../../../shared/fmsContract";
import { applyFmsStateChanged } from "../salesOrderService";
import { hmacSha256Hex } from "../soDispatcher";

export const fmsWebhookRouter = new Hono<Env>();

fmsWebhookRouter.post("/", async (c) => {
  const secret = c.env.FMS_WEBHOOK_SECRET || "salvator-secret-key";
  const signature = c.req.header("X-Signature-SHA256");
  const timestampHeader = c.req.header("X-Timestamp");
  const eventIdHeader = c.req.header("X-Event-Id");

  if (!signature) {
    return c.json({ error: "Missing X-Signature-SHA256 header." }, 401);
  }

  // Drift validation (5 minutes)
  if (timestampHeader) {
    const ts = new Date(timestampHeader).getTime();
    if (!Number.isNaN(ts)) {
      const now = Date.now();
      if (Math.abs(now - ts) > 300_000) {
        return c.json({ error: "Timestamp drift exceeds 5 minutes." }, 401);
      }
    }
  }

  const rawBody = await c.req.text();
  const expectedSignature = await hmacSha256Hex(secret, rawBody);

  if (signature.toLowerCase() !== expectedSignature.toLowerCase()) {
    return c.json({ error: "Invalid signature." }, 401);
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Malformed JSON payload." }, 400);
  }

  const parsed = OutboundStateChangedEventSchema.safeParse(bodyJson);
  if (!parsed.success) {
    return c.json({ error: "Invalid event schema.", details: parsed.error.issues }, 400);
  }

  const event = parsed.data;
  // Fallback eventId from header if needed
  if (!event.eventId && eventIdHeader) {
    event.eventId = eventIdHeader;
  }

  try {
    const result = await applyFmsStateChanged(c.env.DB, event);
    return c.json({ ok: true, duplicate: Boolean(result.duplicate), ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fms-webhook] Failed to process event:", message);
    return c.json({ error: "Internal processing error." }, 500);
  }
});
