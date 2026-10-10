import { Router } from "express";
import rateLimit from "express-rate-limit";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { audit } from "../audit.js";
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
  const out = await forwardToSilvy(silvyConfig(), "ask", parsed.data, currentPolicy());
  if (out.status === 200) {
    audit(req.user!.id, "assistant", 0, "ask", {
      question: parsed.data.messages[parsed.data.messages.length - 1]?.content.slice(0, 200),
    });
  } else console.error("[assistant] ask failed:", out.status, out.body.error);
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
  const out = await forwardToSilvy(silvyConfig(), "document", parsed.data, currentPolicy());
  if (out.status === 200) audit(req.user!.id, "assistant", 0, "document", { kind: parsed.data.kind });
  else console.error("[assistant] document failed:", out.status, out.body.error);
  res.status(out.status).json(out.body);
});
