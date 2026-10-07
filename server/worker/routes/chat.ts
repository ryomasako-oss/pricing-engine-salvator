import { Hono } from "hono";
import { requireAuth } from "../auth";
import { handleChat } from "../../chat";
import type { Env } from "../env";

export const chatRouter = new Hono<Env>();
chatRouter.use(requireAuth);

chatRouter.post("/", async (c) => {
  // Each message is a paid Gemini request: throttle per user, like OCR and the assistant.
  const { success } = await c.env.ASSISTANT_LIMITER.limit({ key: `chat:${c.get("user")!.id}` });
  if (!success) return c.json({ error: "Terlalu banyak pesan. Tunggu sebentar." }, 429);
  const out = await handleChat(await c.req.json().catch(() => null), { apiKey: c.env.GEMINI_API_KEY, model: c.env.GEMINI_MODEL });
  return c.json(out.json, out.status as 200);
});
