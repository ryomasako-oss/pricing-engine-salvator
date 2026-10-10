import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearIdTokenCache, googleIdToken, type IdTokenCreds } from "./googleIdToken.js";

const b64u = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

let creds: IdTokenCreds;
let publicKey: Parameters<typeof crypto.subtle.verify>[1];

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  publicKey = pair.publicKey;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  creds = {
    clientEmail: "notify@proj.iam.gserviceaccount.com",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
  };
});

beforeEach(() => clearIdTokenCache());

/** A Google-shaped id_token whose payload carries `exp`. */
const fakeIdToken = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

function tokenServer(expSeconds: number) {
  const calls: { url: string; assertion: string; grant: string | null }[] = [];
  const fn = (async (url: any, init: any) => {
    const body = new URLSearchParams(String(init.body));
    calls.push({ url: String(url), assertion: body.get("assertion")!, grant: body.get("grant_type") });
    return new Response(JSON.stringify({ id_token: fakeIdToken(expSeconds) }), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("googleIdToken", () => {
  it("signs a JWT with target_audience (and no scope) that verifies with the public key", async () => {
    const now = 1_800_000_000_000;
    const s = tokenServer(now / 1000 + 3600);
    await googleIdToken(creds, "https://agent.example.run.app", s.fn, now);

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(s.calls[0].grant).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [h, c, sig] = s.calls[0].assertion.split(".");
    const claims = JSON.parse(fromB64u(c).toString());
    expect(claims).toEqual({
      iss: creds.clientEmail,
      sub: creds.clientEmail,
      aud: "https://oauth2.googleapis.com/token",
      target_audience: "https://agent.example.run.app",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });
    expect(claims.scope).toBeUndefined();
    expect(JSON.parse(fromB64u(h).toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromB64u(sig), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it("returns the id_token and reuses it until 5 minutes before expiry", async () => {
    const now = 1_800_000_000_000;
    const s = tokenServer(now / 1000 + 3600);
    const a = await googleIdToken(creds, "https://a", s.fn, now);
    const b = await googleIdToken(creds, "https://a", s.fn, now + 3000_000); // 50 min later: still cached
    expect(b).toBe(a);
    expect(s.calls).toHaveLength(1);
    await googleIdToken(creds, "https://a", s.fn, now + 3400_000); // 56.6 min: inside the skew window
    expect(s.calls).toHaveLength(2);
  });

  it("caches per audience", async () => {
    const now = 1_800_000_000_000;
    const s = tokenServer(now / 1000 + 3600);
    await googleIdToken(creds, "https://a", s.fn, now);
    await googleIdToken(creds, "https://b", s.fn, now);
    expect(s.calls).toHaveLength(2);
  });

  it("honours a token URL override and fails loudly on a bad exchange", async () => {
    const s = tokenServer(1_800_003_600);
    await googleIdToken({ ...creds, tokenUrl: "http://127.0.0.1:1/token" }, "https://a", s.fn, 1_800_000_000_000);
    expect(s.calls[0].url).toBe("http://127.0.0.1:1/token");

    clearIdTokenCache();
    await expect(googleIdToken(creds, "https://a", (async () => new Response("no", { status: 401 })) as typeof fetch)).rejects.toThrow(/401/);
    await expect(googleIdToken(creds, "https://a", (async () => new Response("{}", { status: 200 })) as typeof fetch)).rejects.toThrow(/no id_token/);
  });
});
