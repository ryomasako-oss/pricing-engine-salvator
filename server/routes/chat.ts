import { Router } from "express";
import rateLimit from "express-rate-limit";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { handleChat } from "../chat.js";

export const chatRouter = Router();
chatRouter.use(requireAuth);

// Each message is a paid Gemini request: throttle per user, like OCR and the assistant.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => `chat:${(req as AuthedRequest).user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak pesan. Tunggu sebentar." },
});

chatRouter.post("/", limiter, async (req, res) => {
  const out = await handleChat(req.body, { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL });
  res.status(out.status).json(out.json);
});
