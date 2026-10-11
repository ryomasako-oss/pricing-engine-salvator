/* ============================================================
   Gerbang ke Silvy (agent-service). Dipakai bersama oleh backend
   Express dan Worker supaya keduanya membuat keputusan yang sama.

   App tetap yang mengautentikasi user, menolak staff, membatasi
   laju, dan mencatat audit. Berkas ini hanya: memvalidasi masukan,
   meneruskan ke agent dengan rahasia bersama, dan menerjemahkan
   kegagalan jadi pesan yang bisa ditindak.
   ============================================================ */

import { z } from "zod";
import type { PricingPolicy } from "../shared/types.js";
import { snapshotSchema } from "./validate.js";
import { googleIdToken, type IdTokenCreds } from "./googleIdToken.js";

export interface SilvyConfig {
  url?: string;
  secret?: string;
  /**
   * Present when the agent is a private Cloud Run service: the app then sends a
   * Google ID token (audience = the agent URL) on top of the shared secret.
   */
  iam?: { clientEmail?: string; privateKeyPem?: string; tokenUrl?: string };
}

export const silvyEnabled = (c: SilvyConfig): boolean =>
  Boolean(c.url?.trim() && c.secret && (!c.iam || (c.iam.clientEmail && c.iam.privateKeyPem)));

/** Build the config from either backend's environment (process.env or Worker bindings). */
export function silvyConfigFrom(env: Record<string, string | undefined>): SilvyConfig {
  const cfg: SilvyConfig = { url: env.SILVY_URL, secret: env.SILVY_SHARED_SECRET };
  if (env.SILVY_IAM_AUTH === "true") {
    cfg.iam = {
      clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.GOOGLE_PRIVATE_KEY,
      tokenUrl: env.SILVY_TOKEN_URL || undefined,
    };
  }
  return cfg;
}

export const SILVY_OFF_MESSAGE = "Silvy belum aktif. Isi SILVY_URL dan SILVY_SHARED_SECRET di server.";
export const SILVY_BUSY_MESSAGE = "Silvy sedang kena batas pemakaian. Coba lagi sebentar lagi.";

const contextInput = z.object({
  snapshot: snapshotSchema,
  number: z.string().max(64).default(""),
  title: z.string().max(200).default(""),
  status: z.string().max(32).default("draft"),
  clientName: z.string().max(200).default("Klien"),
  sections: z.record(z.boolean()).default({}),
  notes: z
    .array(z.object({ id: z.string().max(64), title: z.string().max(200), text: z.string().max(20000) }))
    .max(20)
    .default([]),
});

export const askSchema = z.object({
  context: contextInput,
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(20),
});

export const documentSchema = z.object({
  context: contextInput,
  kind: z.enum(["briefing", "faq", "risk", "negotiation"]),
});

export type SilvyPath = "ask" | "document";

export interface SilvyReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Teruskan permintaan ke agent. Kebijakan harga berasal dari server (bukan
 * browser), jadi ikut dikirim di sini. Tidak pernah melempar: kegagalan
 * jaringan, timeout, dan balasan non-JSON dijadikan {error}.
 */
export async function forwardToSilvy(
  cfg: SilvyConfig,
  path: SilvyPath,
  payload: Record<string, unknown>,
  policy: PricingPolicy,
  fetchImpl: typeof fetch = fetch,
): Promise<SilvyReply> {
  if (!silvyEnabled(cfg)) return { status: 503, body: { error: SILVY_OFF_MESSAGE } };
  const base = cfg.url!.trim().replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json", "x-silvy-secret": cfg.secret! };
  if (cfg.iam) {
    try {
      headers.authorization = `Bearer ${await googleIdToken(cfg.iam as IdTokenCreds, base, fetchImpl)}`;
    } catch {
      return {
        status: 502,
        body: { error: "Silvy tidak bisa dihubungi: token akses ke layanannya gagal dibuat. Periksa GOOGLE_SERVICE_ACCOUNT_* di server." },
      };
    }
  }
  let res: Response;
  try {
    res = await fetchImpl(`${base}/silvy/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, policy }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { status: 503, body: { error: "Tidak bisa menghubungi Silvy. Coba lagi nanti." } };
  }
  const json = await res.json().catch(() => null);
  if (res.ok && json && typeof json === "object") return { status: 200, body: json as Record<string, unknown> };
  // Cloud Run answers 403 before the agent when the caller lacks roles/run.invoker.
  if (res.status === 403) return { status: 502, body: { error: "Silvy menolak akses dari app. Periksa izin run.invoker untuk akun layanan app." } };
  if (res.status === 429) return { status: 429, body: { error: SILVY_BUSY_MESSAGE } };
  // 401 dari agent berarti rahasia tidak cocok: kesalahan konfigurasi, bukan salah user.
  if (res.status === 401) return { status: 502, body: { error: "Silvy menolak koneksi dari app. Periksa SILVY_SHARED_SECRET." } };
  const msg = json && typeof (json as any).error === "string" ? (json as any).error : `Silvy mengembalikan error ${res.status}.`;
  return { status: res.status === 400 ? 400 : res.status === 503 ? 503 : 502, body: { error: msg } };
}
