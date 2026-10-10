import { Hono } from "hono";
import { requireAuth } from "../auth";
import { audit } from "../audit";
import { get } from "../../db.d1";
import { QUOTA_COUNT_SQL, dayStartUtc, monthStartUtc, quotaLimitsFrom, quotaVerdict } from "../../../shared/silvyQuota";
import { currentPolicy } from "../quoteService";
import { DOCS } from "../../../shared/silvyDocs";
import { zodMessage } from "../../validate";
import { STAFF_ASSISTANT_DENIED, canSeeCosts } from "../../staffView";
import { SILVY_BUSY_MESSAGE, SILVY_OFF_MESSAGE, askSchema, documentSchema, forwardToSilvy, silvyConfigFrom, silvyEnabled, type SilvyConfig } from "../../silvy";
import { clientIp, type Bindings, type Env } from "../env";

// Silvy (agent-service) menjawab; router ini hanya gerbangnya. Path tetap
// /api/assistant supaya panel di browser tidak berubah.
export const assistantRouter = new Hono<Env>();
assistantRouter.use(requireAuth);

// Silvy dilandasi COGS dan margin yang dikirim browser, jadi staff tidak boleh
// memakainya (PE-1). /status tetap terbuka agar UI tahu harus menyembunyikannya.
assistantRouter.use(async (c, next) => {
  if (!c.req.path.endsWith("/status") && !canSeeCosts(c.get("user")!.role)) {
    return c.json({ error: STAFF_ASSISTANT_DENIED }, 403);
  }
  await next();
});

type SilvyEnv = Pick<
  Bindings,
  "SILVY_URL" | "SILVY_SHARED_SECRET" | "SILVY_IAM_AUTH" | "GOOGLE_SERVICE_ACCOUNT_EMAIL" | "GOOGLE_PRIVATE_KEY"
> & { SILVY_TOKEN_URL?: string };
export const silvyConfig = (env: SilvyEnv): SilvyConfig => silvyConfigFrom(env);
export const assistantEnabled = (env: SilvyEnv): boolean => silvyEnabled(silvyConfig(env));

/** Refuse before spending anything on Gemini once a monthly or per-user daily cap is reached. */
async function overQuota(env: Bindings, userId: number): Promise<string | null> {
  const now = new Date();
  const month = (await get<{ n: number }>(env.DB, QUOTA_COUNT_SQL.month, monthStartUtc(now)))?.n ?? 0;
  const userToday = (await get<{ n: number }>(env.DB, QUOTA_COUNT_SQL.userDay, userId, dayStartUtc(now)))?.n ?? 0;
  const v = quotaVerdict({ month, userToday }, quotaLimitsFrom(env as unknown as Record<string, string | undefined>));
  return v.ok ? null : v.message;
}

assistantRouter.get("/status", (c) => c.json({ enabled: assistantEnabled(c.env), model: "Silvy", docs: DOCS }));

assistantRouter.post("/ask", async (c) => {
  const user = c.get("user")!;
  if (!assistantEnabled(c.env)) return c.json({ error: SILVY_OFF_MESSAGE }, 503);
  // Pembatas laju yang sama dengan express-rate-limit di server Express.
  const { success } = await c.env.ASSISTANT_LIMITER.limit({ key: clientIp(c) });
  if (!success) return c.json({ error: SILVY_BUSY_MESSAGE }, 429);

  const parsed = askSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);

  const blocked = await overQuota(c.env, user.id);
  if (blocked) return c.json({ error: blocked }, 429);
  const out = await forwardToSilvy(silvyConfig(c.env), "ask", parsed.data, await currentPolicy(c.env.DB));
  if (out.status === 200) {
    await audit(c.env.DB, user.id, "assistant", 0, "ask", {
      question: parsed.data.messages[parsed.data.messages.length - 1]?.content.slice(0, 200),
    });
  } else console.error("[assistant] ask failed:", out.status, out.body.error);
  return c.json(out.body, out.status as any);
});

assistantRouter.post("/document", async (c) => {
  const user = c.get("user")!;
  if (!assistantEnabled(c.env)) return c.json({ error: SILVY_OFF_MESSAGE }, 503);
  const { success } = await c.env.ASSISTANT_LIMITER.limit({ key: clientIp(c) });
  if (!success) return c.json({ error: SILVY_BUSY_MESSAGE }, 429);

  const parsed = documentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);

  const blocked = await overQuota(c.env, user.id);
  if (blocked) return c.json({ error: blocked }, 429);
  const out = await forwardToSilvy(silvyConfig(c.env), "document", parsed.data, await currentPolicy(c.env.DB));
  if (out.status === 200) await audit(c.env.DB, user.id, "assistant", 0, "document", { kind: parsed.data.kind });
  else console.error("[assistant] document failed:", out.status, out.body.error);
  return c.json(out.body, out.status as any);
});
