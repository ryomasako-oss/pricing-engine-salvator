import { Hono } from "hono";
import { requireAuth } from "../auth";
import { handleChat } from "../../chat";
import { runChatSearch } from "../chatSearch";
import { canSeeCosts } from "../../staffView";
import type { Env } from "../env";

export const chatRouter = new Hono<Env>();
chatRouter.use(requireAuth);

chatRouter.post("/", async (c) => {
  // Each message is a paid Gemini request: throttle per user, like OCR and the assistant.
  const { success } = await c.env.ASSISTANT_LIMITER.limit({ key: `chat:${c.get("user")!.id}` });
  if (!success) return c.json({ error: "Terlalu banyak pesan. Tunggu sebentar." }, 429);
  const costs = canSeeCosts(c.get("user")!.role);
  const out = await handleChat(await c.req.json().catch(() => null), { apiKey: c.env.GEMINI_API_KEY, model: c.env.GEMINI_MODEL }, costs);
  if (out.status !== 200 || !("search" in out.json) || !out.json.search) return c.json(out.json, out.status as 200);
  const { search, ...reply } = out.json;
  const found = await runChatSearch(c.env.DB, search, costs);
  if ("denied" in found) return c.json({ ...reply, reply: "Maaf, pencarian berdasarkan COGS hanya bisa dipakai manajer." });
  return c.json({ ...reply, found });
});
