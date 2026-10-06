import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { handleOcr } from "../ocr.js";

export const ocrRouter = Router();
ocrRouter.use(requireAuth);

// Each call is a paid Gemini request: throttle per user, like the assistant.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `ocr:${(req as AuthedRequest).user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan OCR. Tunggu sebentar." },
});

/** Body: the file as base64 text. Header X-File-Mime: its type. */
ocrRouter.post("/extract", limiter, express.text({ type: "*/*", limit: "6mb" }), async (req, res) => {
  const out = await handleOcr(req.header("x-file-mime"), typeof req.body === "string" ? req.body : "", {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
  });
  res.status(out.status).json(out.json);
});
