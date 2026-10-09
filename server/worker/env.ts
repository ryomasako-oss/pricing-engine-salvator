/* Bindings/secrets available to every request on Workers. No process.env. */

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  NODE_ENV?: string;
  /* Silvy (agent-service). URL dasar dan rahasia bersama; set with `wrangler secret put SILVY_SHARED_SECRET`. */
  SILVY_URL?: string;
  SILVY_SHARED_SECRET?: string;
  /* Reads PDF/photo request lists (server/ocr.ts). Set with `wrangler secret put GEMINI_API_KEY`. */
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_NAME?: string;
  AUTH_LIMITER: RateLimit;
  ASSISTANT_LIMITER: RateLimit;
  API_LIMITER: RateLimit;
  APP_URL?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_SEND_AS_EMAIL?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string;
  /* Accurate Online (API Token auth). Set with `wrangler secret put`. One
     token per Data Usaha; an entity without a token is skipped. */
  ACCURATE_SIGNATURE_SECRET?: string;
  ACCURATE_TOKEN_CV?: string;
  ACCURATE_TOKEN_PT?: string;
  ACCURATE_PAGE_SIZE?: string;
  ACCURATE_CALLS_PER_TICK?: string;
  ACCURATE_SYNC_EVERY_HOURS?: string;
  ACCURATE_SYNC_ENABLED?: string;
  /** The Data Usaha whose data may be applied to the catalog ("PT" or "CV"; default PT). */
  ACCURATE_CATALOG_ENTITY?: string;
}

/** Client IP as seen by Cloudflare's edge, for keying rate limits. */
export const clientIp = (c: { req: { header: (name: string) => string | undefined } }): string =>
  c.req.header("cf-connecting-ip") ?? "unknown";

import type { User } from "../../shared/types";

export interface Variables {
  user?: User;
}

export type Env = { Bindings: Bindings; Variables: Variables };
