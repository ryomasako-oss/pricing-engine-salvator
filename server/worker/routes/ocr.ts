import { Hono } from "hono";
import { requireAuth } from "../auth";
import { handleOcr } from "../../ocr";
import type { Env } from "../env";

export const ocrRouter = new Hono<Env>();
ocrRouter.use(requireAuth);

/** Body: the file as base64 text. Header X-File-Mime: its type. */
ocrRouter.post("/extract", async (c) => {
  // Each call is a paid Gemini request: throttle per user, like the assistant.
  const { success } = await c.env.ASSISTANT_LIMITER.limit({ key: `ocr:${c.get("user")!.id}` });
  if (!success) return c.json({ error: "Terlalu banyak permintaan OCR. Tunggu sebentar." }, 429);
  // Refuse before reading a huge body into memory.
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > 6 * 1024 * 1024) return c.json({ error: "File terlalu besar (maksimal 4 MB)." }, 413);
  const out = await handleOcr(c.req.header("x-file-mime"), await c.req.text(), {
    apiKey: c.env.GEMINI_API_KEY,
    model: c.env.GEMINI_MODEL,
  });
  return c.json(out.json, out.status as 200);
});
