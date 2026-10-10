import { Router } from "express";
import rateLimit from "express-rate-limit";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { get, run } from "../db.js";
import { QUOTA_COUNT_SQL, QUOTA_RESERVE_SQL, dayStartUtc, monthStartUtc, quotaLimitsFrom, quotaReservationParams, quotaVerdict, type QuotaReservation } from "../../shared/silvyQuota.js";
import { currentPolicy } from "../quoteService.js";
import { DOCS } from "../../shared/silvyDocs.js";
import { zodMessage } from "../validate.js";
import { STAFF_ASSISTANT_DENIED, canSeeCosts } from "../staffView.js";
import { SILVY_BUSY_MESSAGE, SILVY_OFF_MESSAGE, askSchema, documentSchema, forwardToSilvy, silvyConfigFrom, silvyEnabled, type SilvyConfig } from "../silvy.js";

// Silvy (agent-service) menjawab; router ini hanya gerbangnya. Path tetap
// /api/assistant supaya panel di browser tidak berubah.
export const assistantRouter = Router();
assistantRouter.use(requireAuth);

// Silvy dilandasi COGS dan margin yang dikirim browser, jadi staff tidak boleh
// memakainya (PE-1). /status tetap terbuka agar UI tahu harus menyembunyikannya.
assistantRouter.use((req: AuthedRequest, res, next) => {
  if (req.path !== "/status" && !canSeeCosts(req.user!.role)) {
    res.status(403).json({ error: STAFF_ASSISTANT_DENIED });
    return;
  }
  next();
});

const silvyConfig = (): SilvyConfig => silvyConfigFrom(process.env);
export const assistantEnabled = (): boolean => silvyEnabled(silvyConfig());

const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: SILVY_BUSY_MESSAGE },
});

/** Refuse before spending anything on Gemini once a monthly or per-user daily cap is reached. */
function reserveQuota(userId: number, action: "ask" | "document", detail: Record<string, unknown>): QuotaReservation {
  const now = new Date();
  const limits = quotaLimitsFrom(process.env);
  const result = run(QUOTA_RESERVE_SQL, ...quotaReservationParams(userId, action, detail, limits, now));
  if (Number(result.changes) === 1) return { ok: true, id: Number(result.lastInsertRowid) };
  const month = get<{ n: number }>(QUOTA_COUNT_SQL.month, monthStartUtc(now))?.n ?? 0;
  const userToday = get<{ n: number }>(QUOTA_COUNT_SQL.userDay, userId, dayStartUtc(now))?.n ?? 0;
  const v = quotaVerdict({ month, userToday }, limits);
  return v.ok ? { ok: false, message: SILVY_BUSY_MESSAGE } : v;
}

assistantRouter.get("/status", (_req, res) => {
  res.json({ enabled: assistantEnabled(), model: "Silvy", docs: DOCS });
});

assistantRouter.post("/ask", askLimiter, async (req: AuthedRequest, res) => {
  if (!assistantEnabled()) {
    res.status(503).json({ error: SILVY_OFF_MESSAGE });
    return;
  }
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  const policy = currentPolicy();
  const reservation = reserveQuota(req.user!.id, "ask", {
    question: parsed.data.messages[parsed.data.messages.length - 1]?.content.slice(0, 200),
  });
  if (!reservation.ok) {
    res.status(429).json({ error: reservation.message });
    return;
  }
  const out = await forwardToSilvy(silvyConfig(), "ask", parsed.data, policy);
  audit(req.user!.id, "assistant", 0, out.status === 200 ? "ask_completed" : "ask_failed", { reservationId: reservation.id, status: out.status });
  if (out.status !== 200) console.error("[assistant] ask failed:", out.status, out.body.error);
  res.status(out.status).json(out.body);
});

assistantRouter.post("/document", askLimiter, async (req: AuthedRequest, res) => {
  if (!assistantEnabled()) {
    res.status(503).json({ error: SILVY_OFF_MESSAGE });
    return;
  }
  const parsed = documentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  const policy = currentPolicy();
  const reservation = reserveQuota(req.user!.id, "document", { kind: parsed.data.kind });
  if (!reservation.ok) {
    res.status(429).json({ error: reservation.message });
    return;
  }
  const out = await forwardToSilvy(silvyConfig(), "document", parsed.data, policy);
  audit(req.user!.id, "assistant", 0, out.status === 200 ? "document_completed" : "document_failed", { reservationId: reservation.id, status: out.status });
  if (out.status !== 200) console.error("[assistant] document failed:", out.status, out.body.error);
  res.status(out.status).json(out.body);
});
