import { beforeEach, describe, expect, it } from "vitest";
import { forwardToSilvy, silvyConfigFrom, silvyEnabled } from "./silvy.js";
import { clearIdTokenCache } from "./googleIdToken.js";
import { DEFAULT_POLICY } from "../shared/policy.js";

beforeEach(() => clearIdTokenCache());

describe("silvyConfigFrom / silvyEnabled", () => {
  it("is off without a URL or secret", () => {
    expect(silvyEnabled(silvyConfigFrom({}))).toBe(false);
    expect(silvyEnabled(silvyConfigFrom({ SILVY_URL: "https://x" }))).toBe(false);
    expect(silvyEnabled(silvyConfigFrom({ SILVY_URL: "https://x", SILVY_SHARED_SECRET: "s" }))).toBe(true);
  });

  it("with SILVY_IAM_AUTH it also needs the service-account credentials", () => {
    const base = { SILVY_URL: "https://x", SILVY_SHARED_SECRET: "s", SILVY_IAM_AUTH: "true" };
    expect(silvyEnabled(silvyConfigFrom(base))).toBe(false);
    expect(silvyEnabled(silvyConfigFrom({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: "a@b" }))).toBe(false);
    expect(silvyEnabled(silvyConfigFrom({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: "a@b", GOOGLE_PRIVATE_KEY: "k" }))).toBe(true);
  });

  it("only the exact string 'true' turns IAM auth on", () => {
    for (const v of ["1", "yes", "TRUE", "false", ""]) {
      expect(silvyConfigFrom({ SILVY_URL: "u", SILVY_SHARED_SECRET: "s", SILVY_IAM_AUTH: v }).iam).toBeUndefined();
    }
  });
});

describe("forwardToSilvy error mapping", () => {
  const cfg = { url: "https://agent/", secret: "s" };
  const post = (status: number, body: unknown = {}) =>
    forwardToSilvy(cfg, "ask", {}, DEFAULT_POLICY, (async () => new Response(JSON.stringify(body), { status })) as typeof fetch);

  it("passes a 200 through and sends the secret, without an authorization header when IAM is off", async () => {
    let headers: Record<string, string> = {};
    const out = await forwardToSilvy(cfg, "ask", {}, DEFAULT_POLICY, (async (_u: any, init: any) => {
      headers = init.headers;
      return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
    }) as typeof fetch);
    expect(out).toEqual({ status: 200, body: { answer: "ok" } });
    expect(headers["x-silvy-secret"]).toBe("s");
    expect(headers.authorization).toBeUndefined();
  });

  it("a 403 from Cloud Run is reported as a missing invoker permission (502), not a user error", async () => {
    const out = await post(403);
    expect(out.status).toBe(502);
    expect(String(out.body.error)).toMatch(/run\.invoker/);
  });

  it("a 401 stays a shared-secret problem, 429 stays 429, 400 stays 400", async () => {
    expect((await post(401)).status).toBe(502);
    expect(String((await post(401)).body.error)).toMatch(/SILVY_SHARED_SECRET/);
    expect((await post(429)).status).toBe(429);
    expect((await post(400, { error: "rusak" })).body.error).toBe("rusak");
  });

  it("IAM mode: a failed token exchange is a 502 and the agent is never called", async () => {
    let agentCalls = 0;
    const out = await forwardToSilvy(
      { ...cfg, iam: { clientEmail: "a@b", privateKeyPem: "not a key" } },
      "ask",
      {},
      DEFAULT_POLICY,
      (async () => {
        agentCalls++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    );
    expect(out.status).toBe(502);
    expect(String(out.body.error)).toMatch(/token akses/);
    expect(agentCalls).toBe(0);
  });
});
