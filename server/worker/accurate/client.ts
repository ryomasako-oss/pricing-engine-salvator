/* ============================================================
   Accurate Online API client — API Token authorization.

   Per Accurate's "API Token" guide (v1.0.3):
   - Authorization:   Bearer <API Token>   (one token per Data Usaha)
   - X-Api-Timestamp: request time; ±600 s tolerance. Unix ms accepted.
   - X-Api-Signature: base64(HMAC-SHA256(key = Signature Secret,
                                         msg = X-Api-Timestamp value))
   - POST https://account.accurate.id/api/api-token.do returns the
     database "host"; every data call goes to <host>/accurate/api/...
   - The host can move: old host answers 308 with the new location.
     fetch() drops Authorization on cross-origin redirects, so redirects
     are followed by hand and the new host is reported back to the caller.
   - Limits: 8 calls/second and 8 in flight per token. Calls here are
     sequential with a small gap, so a single sync stays well under that.

   Read-only by design: this client exposes GET list endpoints only.
   Credentials only ever go to https://*.accurate.id (assertAccurateUrl).
   ============================================================ */

export const ACCOUNT_BASE = "https://account.accurate.id";

/**
 * Every request carries the Bearer token and a signature, so it may only go
 * to Accurate itself: https on accurate.id or a subdomain. Checked before each
 * request, which covers a 308 to another host, the database host returned by
 * api-token.do, and a host cached in accurate_sync_state.
 */
export function assertAccurateUrl(url: string): void {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !(host === "accurate.id" || host.endsWith(".accurate.id"))) {
    throw new AccurateError(
      `Alamat ${u.protocol}//${u.host} di luar accurate.id; permintaan dihentikan supaya token tidak terkirim ke sana`,
      502,
    );
  }
}

export class AccurateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** base64(HMAC-SHA256(secret, timestamp)) — the X-Api-Signature value. */
export async function signTimestamp(timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp));
  let bin = "";
  for (const b of new Uint8Array(mac)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface AccurateCreds {
  token: string;
  signatureSecret: string;
}

export interface Paged<T> {
  rows: T[];
  page: number;
  pageCount: number;
  rowCount: number;
}

type Fetch = typeof fetch;

export class AccurateClient {
  /** Set when a 308 moved this database to a new host mid-call. */
  movedTo: string | null = null;
  calls = 0;

  constructor(
    private readonly creds: AccurateCreds,
    private host: string | null = null,
    // An arrow, not `fetch` itself: kept in a field and called as this.fetchImpl(...),
    // the global fetch runs with this client as its receiver, which Cloudflare
    // Workers rejects ("Illegal invocation"). Node doesn't, so only the real
    // runtime showed it.
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly gapMs = 130,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const ts = String(Date.now());
    return {
      Authorization: `Bearer ${this.creds.token}`,
      "X-Api-Timestamp": ts,
      "X-Api-Signature": await signTimestamp(ts, this.creds.signatureSecret),
      Accept: "application/json",
    };
  }

  private async send(url: string, method: "GET" | "POST"): Promise<unknown> {
    let target = url;
    for (let hop = 0; hop < 3; hop++) {
      if (this.calls > 0 && this.gapMs > 0) await new Promise((r) => setTimeout(r, this.gapMs));
      assertAccurateUrl(target);
      this.calls++;
      const res = await this.fetchImpl(target, { method, headers: await this.headers(), redirect: "manual" });
      if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
        const loc = res.headers.get("location");
        if (!loc) throw new AccurateError(`Accurate redirect ${res.status} tanpa Location`, res.status);
        const next = new URL(loc, target);
        if (this.host && next.origin !== new URL(target).origin) {
          this.host = next.origin;
          this.movedTo = next.origin;
        }
        target = next.toString();
        continue;
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new AccurateError(`Respons Accurate bukan JSON (HTTP ${res.status}): ${text.slice(0, 160)}`, res.status);
      }
      if (!res.ok) throw new AccurateError(describeError(body) ?? `HTTP ${res.status}`, res.status);
      const b = body as { s?: boolean };
      if (b.s === false) throw new AccurateError(describeError(body) ?? "Accurate menolak permintaan", res.status);
      return body;
    }
    throw new AccurateError("Terlalu banyak redirect dari Accurate", 508);
  }

  /** Token info, including the database host to use for data calls. */
  async tokenInfo(): Promise<{ host: string; alias: string; dbId: number | null }> {
    const body = (await this.send(`${ACCOUNT_BASE}/api/api-token.do`, "POST")) as {
      d?: Record<string, unknown>;
    };
    const d = body.d ?? {};
    // The guide shows the key as "data usaha"; be lenient about its spelling.
    const db = (d["data usaha"] ?? d["dataUsaha"] ?? d["database"] ?? d["db"]) as
      | { host?: string; alias?: string; id?: number }
      | undefined;
    if (!db?.host) throw new AccurateError("api-token.do tidak mengembalikan host database", 502);
    this.host = db.host.replace(/\/+$/, "");
    return { host: this.host, alias: db.alias ?? "", dbId: db.id ?? null };
  }

  get currentHost(): string | null {
    return this.host;
  }

  async ensureHost(): Promise<string> {
    if (!this.host) await this.tokenInfo();
    return this.host!;
  }

  /** GET <host>/accurate/api/<path> with query params; returns the paged "d" list. */
  async list<T = Record<string, unknown>>(path: string, params: Record<string, string | number>): Promise<Paged<T>> {
    const host = await this.ensureHost();
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const body = (await this.send(`${host}/accurate/api/${path}?${qs}`, "GET")) as {
      d?: unknown;
      sp?: { page?: number; pageCount?: number; rowCount?: number };
    };
    const rows = Array.isArray(body.d) ? (body.d as T[]) : [];
    return {
      rows,
      page: body.sp?.page ?? Number(params["sp.page"] ?? 1),
      pageCount: body.sp?.pageCount ?? 1,
      rowCount: body.sp?.rowCount ?? rows.length,
    };
  }

  /** Raw GET, for the admin probe endpoint. */
  async raw(path: string, params: Record<string, string | number>): Promise<unknown> {
    const host = await this.ensureHost();
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return this.send(`${host}/accurate/api/${path}?${qs}`, "GET");
  }
}

function describeError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { d?: unknown; error?: unknown; error_description?: unknown; message?: unknown };
  const pick = b.error_description ?? b.message ?? b.d ?? b.error;
  if (Array.isArray(pick)) return pick.map(String).join("; ").slice(0, 300);
  if (typeof pick === "string") return pick.slice(0, 300);
  return null;
}
