/* Log in once and keep the session cookie: the login route allows 20 tries per
   15 minutes, which a suite that logs in per test would exhaust. */

import fs from "node:fs";
import { request } from "@playwright/test";

export default async function globalSetup() {
  const base = `http://localhost:${process.env.E2E_WEB_PORT ?? "5183"}`;
  fs.mkdirSync("e2e/.auth", { recursive: true });
  for (const [who, email, password] of [
    ["admin", "admin@e2e.test", "e2e-admin-password"],
    ["rep", "sales@e2e.test", "e2e-sales-password"],
  ]) {
    const ctx = await request.newContext({ baseURL: base });
    const res = await ctx.post("/api/auth/login", { data: { email, password } });
    if (!res.ok()) throw new Error(`e2e login (${who}) failed: ${res.status()} ${await res.text()}`);
    await ctx.storageState({ path: `e2e/.auth/${who}.json` });
    await ctx.dispose();
  }
}
