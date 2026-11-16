/* ============================================================
   HMAC-SHA256 untuk integrasi PE <-> FMS (docs/integrasi-pe-fms.md bagian 1).
   POST: tanda tangan atas `${epochDetik}.${rawBody}`.
   GET katalog/klien (F4b): atas `${epochDetik}.${METHOD} ${path}?${query}`.
   Secret kosong atau < 32 karakter = gagal tertutup, tanpa cadangan.
   ============================================================ */

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_CLOCK_DRIFT_S = 300;
export const MIN_SECRET_LENGTH = 32;

/** The secret if it is long enough to use, otherwise null (caller refuses to run). */
export const usableSecret = (secret: string | undefined): string | null =>
  secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;

const enc = new TextEncoder();

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function signHex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks a timestamp + signature header pair. `message` builds the signed
 * string from the timestamp as sent. crypto.subtle.verify compares in
 * constant time; a malformed header is a plain false, never a throw.
 */
export async function verifySignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  message: (ts: string) => string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > MAX_CLOCK_DRIFT_S) return false;
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), bytes, enc.encode(message(timestamp)));
}

/** The request body as text, or null when it is larger than `limit` bytes. */
export async function readBoundedBody(req: Request, limit = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** HTTPS, or plain HTTP to this machine for local development. */
export function allowedTarget(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}
