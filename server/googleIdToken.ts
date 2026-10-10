/* ============================================================
   Google ID token for a service account (JWT Bearer flow with a
   `target_audience` claim). Lets the app call a Cloud Run service
   that is NOT public: the organisation policy forbids allUsers, so
   the caller must present an identity token whose audience is the
   service URL and whose service account holds roles/run.invoker.

   Pure WebCrypto + fetch, like gmail.ts, so it runs unmodified in
   the Express backend and the Cloudflare Worker. Tokens are cached
   in memory per audience until shortly before they expire.
   ============================================================ */

import { importPrivateKey, stringToBase64Url, toBase64Url } from "./gmail.js";

export interface IdTokenCreds {
  clientEmail: string;
  privateKeyPem: string;
  /** Override only in tests. */
  tokenUrl?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh this long before the token's own expiry. */
const SKEW_SECONDS = 300;

const cache = new Map<string, { token: string; expiresAt: number }>();

/** Drop cached tokens (tests). */
export const clearIdTokenCache = (): void => cache.clear();

function expOf(jwt: string): number | null {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export async function googleIdToken(
  creds: IdTokenCreds,
  audience: string,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<string> {
  const key = `${creds.clientEmail}|${audience}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > nowMs / 1000) return hit.token;

  const tokenUrl = creds.tokenUrl ?? TOKEN_URL;
  const now = Math.floor(nowMs / 1000);
  const unsigned =
    `${stringToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    stringToBase64Url(
      JSON.stringify({ iss: creds.clientEmail, sub: creds.clientEmail, aud: tokenUrl, target_audience: audience, iat: now, exp: now + 3600 }),
    );
  const signingKey = await importPrivateKey(creds.privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${toBase64Url(new Uint8Array(signature))}`;

  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`id token exchange failed: ${res.status}`);
  const json = (await res.json().catch(() => null)) as { id_token?: string } | null;
  if (!json?.id_token) throw new Error("id token exchange returned no id_token");

  const exp = expOf(json.id_token) ?? now + 3000;
  cache.set(key, { token: json.id_token, expiresAt: exp - SKEW_SECONDS });
  return json.id_token;
}
