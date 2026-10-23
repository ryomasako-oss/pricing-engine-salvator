import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { runAccurateRecap } from "./accurateRecap";
import { countQueries, PAID_PLAN } from "./accurate/testing";
import type { Bindings } from "./env";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

function seed(sqlite: DatabaseSync, { passDone = true } = {}) {
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role, active) VALUES
    (1, 'ryoma@x', 'Ryoma', 'x', 'admin', 1), (2, 'hesti@x', 'Hesti', 'x', 'manager', 1), (3, 'sales@x', 'Sales', 'x', 'rep', 1)`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES
    ('101311', '3M KESET NOMAD 6050 10 mtr', 'PCS', 10831300, 8250000), ('B1', 'Spidol', 'Pcs', 2000, 3000)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, run_id) VALUES
    ('PT', 1, '101311', '3M KESET NOMAD 6050 10 mtr', 'PCS', 8250000, '[]', 'r'), ('PT', 2, 'B1', 'Spidol', 'Pcs', 3000, '[]', 'r')`);
  sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity, unit_price) VALUES
    ('PT', 89205, 1, 'RI.2026.05.00210', '2026-05-22', '101311', 'PCS', 1, 11005000),
    ('PT', 900, 1, 'RI.2026.06.00001', '2026-06-02', 'B1', 'Lusin', 1, 30000)`);
  sqlite.exec(
    passDone
      ? "INSERT INTO accurate_receipt_state(entity, last_pass_at, since_update, receipts_seen) VALUES ('PT', '2026-10-16T00:30:00Z', '16/10/2026 07:00:00', 4800)"
      : "INSERT INTO accurate_receipt_state(entity, pass_started_at, receipts_seen) VALUES ('PT', '2026-10-15T10:17:46Z', 127)",
  );
}

const env = (db: D1Database, over: Partial<Bindings> = {}) =>
  ({ DB: db, ACCURATE_RECEIPTS_ENABLED: "true", SILVY_URL: "https://silvy.test", SILVY_SHARED_SECRET: "s", ...over }) as unknown as Bindings;

function fakeSilvy(reply: { status: number; body: unknown }) {
  const calls: { url: string; body: any }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

const NOW = new Date("2026-10-16T01:00:00Z"); // 08:00 WIB

describe("runAccurateRecap (rekap Accurate pagi, Silvy)", () => {
  it("asks Silvy once for a summary and emails it with the system's numbers to managers and admins", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    const silvy = fakeSilvy({ status: 200, body: { content: "COGS keset naik.\nPrioritas:\n- Cek 101311\n- Rapikan rasio Lusin B1\n- Cek harga jual 101311" } });
    const sent: { to: string; subject: string; html: string }[] = [];
    const r = await runAccurateRecap(env(db), { now: NOW, link: "https://app/catalog", fetchImpl: silvy.impl, send: async (to, subject, html) => void sent.push({ to, subject, html }) });

    expect(r).toEqual({ sent: 2, silvy: "ok" });
    expect(silvy.calls).toHaveLength(1);
    expect(silvy.calls[0].url).toBe("https://silvy.test/silvy/report");
    expect(silvy.calls[0].body.recap.cogs).toMatchObject({ changed: 1, skipped: 1, topChanges: [{ code: "101311", from: 10831300, to: 11005000 }] });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("hesti@x, ryoma@x"); // managers and admins, as the fix digest; never the sales rep (COGS)
    expect(sent[0].subject).toBe("Rekap Accurate 2026-10-16: 1 COGS berubah, 1 dilewati");
    expect(sent[0].html).toContain("<li>Cek 101311</li>");
    expect(sent[0].html).toContain("Rp 11.005.000");
    expect(sqlite.prepare("SELECT action FROM audit_log WHERE action = 'recap_sent'").all()).toHaveLength(1);

    // Same morning again (a cron retry): nothing more, and no second Gemini call.
    const again = await runAccurateRecap(env(db), { now: new Date("2026-10-16T02:00:00Z"), link: "x", fetchImpl: silvy.impl, send: async () => void sent.push({} as never) });
    expect(again).toEqual({ skipped: "already-sent-today" });
    expect(silvy.calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("still sends the numbers when Silvy fails or isn't configured", async () => {
    for (const over of [{}, { SILVY_URL: undefined }] as Partial<Bindings>[]) {
      const { sqlite, db } = freshDb();
      seed(sqlite);
      const silvy = fakeSilvy({ status: 500, body: { error: "boom" } });
      const sent: string[] = [];
      const r = await runAccurateRecap(env(db, over), { now: NOW, link: "x", fetchImpl: silvy.impl, send: async (_t, _s, html) => void sent.push(html) });
      expect(r).toMatchObject({ sent: 2, silvy: "failed" });
      expect(sent[0]).toContain("Silvy tidak bisa dihubungi");
      expect(sent[0]).toContain("1 akan berubah jika diterapkan");
    }
  });

  it("reports an unfinished history instead of COGS numbers that aren't complete yet", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite, { passDone: false });
    const silvy = fakeSilvy({ status: 200, body: { content: "Riwayat belum lengkap." } });
    const sent: string[] = [];
    await runAccurateRecap(env(db), { now: NOW, link: "x", fetchImpl: silvy.impl, send: async (_t, _s, html) => void sent.push(html) });
    expect(silvy.calls[0].body.recap.receipts).toEqual({ lastPassAt: null, inProgress: true, receiptsSeen: 127 });
    expect(silvy.calls[0].body.recap.cogs.changed).toBe(0);
    expect(sent[0]).toContain("masih dikumpulkan");
  });

  it("calls neither Silvy nor Gmail on a day with nothing to act on, or when receipts are off", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    // COGS already equal to the last purchase, the selling price above it, nothing skipped.
    sqlite.exec(`UPDATE catalog_items SET cogs = 11005000, list_price = 12000000 WHERE code = '101311';
      UPDATE accurate_items SET unit_price = 12000000 WHERE code = '101311';
      DELETE FROM accurate_receipt_lines WHERE item_code = 'B1'`);
    const silvy = fakeSilvy({ status: 200, body: { content: "x" } });
    let sends = 0;
    expect(await runAccurateRecap(env(db), { now: NOW, link: "x", fetchImpl: silvy.impl, send: async () => void sends++ })).toEqual({ skipped: "nothing-to-report" });
    expect(await runAccurateRecap(env(db, { ACCURATE_RECEIPTS_ENABLED: "false" }), { now: new Date("2026-10-17T01:00:00Z"), link: "x", fetchImpl: silvy.impl, send: async () => void sends++ })).toEqual({ skipped: "disabled" });
    expect(silvy.calls).toHaveLength(0);
    expect(sends).toBe(0);
  });

  it("stays well inside the plan's D1 queries per invocation", async () => {
    const { sqlite, db: raw } = freshDb();
    seed(sqlite);
    const { db, queries } = countQueries(raw);
    const silvy = fakeSilvy({ status: 200, body: { content: "ok" } });
    await runAccurateRecap(env(db), { now: NOW, link: "x", fetchImpl: silvy.impl, send: async () => {} });
    expect(queries()).toBeLessThan(25);
    expect(queries()).toBeLessThan(PAID_PLAN.d1Queries);
  });

  it("lists the items the cron added in the last day, with the purchase price waiting for them", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES ('103279', 'JOYKO MECHANICAL PENCIL MP-52', 'PCS', 0, 0), ('103300', 'Map baru', 'Pcs', 0, 0), ('OLDNEW', 'Kemarin lusa', 'Pcs', 0, 0)`);
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, run_id) VALUES ('PT', 64601, '103279', 'JOYKO MECHANICAL PENCIL MP-52', 'PCS', 0, '[]', 'r')`);
    sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity, unit_price) VALUES
      ('PT', 104308, 116382, 'RI.2026.10.00309', '2026-10-16', '103279', 'PCS', 12, 2083.333333)`);
    sqlite.exec(`INSERT INTO audit_log(actor_id, entity, entity_id, action, detail, created_at) VALUES
      (NULL, 'catalog', 0, 'accurate_new_items', '{"entity":"PT","added":2,"codes":["103279","103300"]}', '2026-10-15 20:00:00'),
      (NULL, 'catalog', 0, 'accurate_new_items', '{"entity":"PT","added":1,"codes":["OLDNEW"]}', '2026-10-14 20:00:00')`);
    const silvy = fakeSilvy({ status: 200, body: { content: "ok" } });
    const sent: { subject: string; html: string }[] = [];
    await runAccurateRecap(env(db), { now: NOW, link: "x", fetchImpl: silvy.impl, send: async (_to, subject, html) => void sent.push({ subject, html }) });
    // One receipt and no COGS yet: nothing for the guard to compare with, so Terapkan COGS writes it.
    expect(silvy.calls[0].body.recap.cogs.topHeld).toEqual([]);
    expect(silvy.calls[0].body.recap.newItems).toEqual({
      added: 2,
      withReceipt: 1,
      held: 0,
      top: [{ code: "103300", name: "Map baru", cost: 0, held: false }, { code: "103279", name: "JOYKO MECHANICAL PENCIL MP-52", cost: 2083.33, held: false }],
    });
    expect(sent[0].subject).toContain("2 barang baru");
    expect(sent[0].html).not.toContain("OLDNEW");
  });
});
