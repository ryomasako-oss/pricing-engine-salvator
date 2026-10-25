import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GmailClient } from "./email.js";

test("send: a non-ASCII subject reaches Gmail RFC 2047-encoded and decodes back", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let sent: { headers: Record<string, string>; body: string } | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    sent = { headers: init.headers as Record<string, string>, body: String(init.body) };
    return new Response("{}");
  }) as typeof fetch;
  try {
    const subject = "Penawaran — Rp 15.000";
    await new GmailClient({ clientEmail: "sa@x.iam", privateKeyPem: privateKey, impersonatedUser: "noreply@salvator.co.id" })
      .send("rep@salvator.co.id", subject, "<p>Hi</p>");

    // users.messages.send takes JSON {raw: base64url(RFC 2822 message)}.
    const { raw } = JSON.parse(sent!.body) as { raw: string };
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    const m = mime.match(/^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/]+=*)\?=$/m);
    assert.ok(m, `no RFC 2047 subject header in:\n${mime}`);
    assert.equal(Buffer.from(m[1], "base64").toString("utf8"), subject);
  } finally {
    globalThis.fetch = realFetch;
  }
});
