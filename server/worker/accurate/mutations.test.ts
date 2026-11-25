import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateDate, mapMutation, mutationStep } from "./mutations";

/* Riwayat mutasi stok (2026-11-25): Accurate hanya memberi 7 hari; aplikasi menyimpannya sendiri. */

const NOW = new Date("2026-11-25T09:00:00Z"); // 16:00 WIB
const row = (id: number, created: string, extra: Record<string, unknown> = {}) => ({
  id, itemNo: `B-${id % 3}`, warehouseName: "Utama", transactionType: "DO", transactionNumber: `DO.${id}`,
  transactionId: 9000 + id, transactionDate: created.slice(0, 10), createDate: created, mutation: -2, itemCost: 0, ...extra,
});

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec("INSERT INTO accurate_sync_state(entity, host) VALUES ('PT', 'https://zeus.accurate.id')");
  let rows: Record<string, unknown>[] = [];
  let fail = false;
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (fail) return new Response(JSON.stringify({ s: false, d: ["insufficient_scope"] }), { status: 403 });
    const page = Number(url.searchParams.get("sp.page"));
    const size = Number(url.searchParams.get("sp.pageSize"));
    const d = rows.slice((page - 1) * size, page * size);
    return new Response(JSON.stringify({ s: true, d, sp: { page, pageSize: size, pageCount: Math.max(1, Math.ceil(rows.length / size)), rowCount: rows.length } }));
  }) as typeof fetch;
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  const step = (now = NOW, budget = 40) =>
    mutationStep(db, "PT", { token: "aat.t", signatureSecret: "s" }, { everyHours: 2, budget, deadline: Date.now() + 10_000, fetchImpl, gapMs: 0, now });
  const q = (sql: string) => sqlite.prepare(sql).all() as Record<string, unknown>[];
  return { step, q, calls, setRows: (r: Record<string, unknown>[]) => (rows = r), setFail: (f: boolean) => (fail = f) };
}

describe("riwayat mutasi stok", () => {
  it("maps Accurate's row and dates", () => {
    expect(accurateDate("18/11/2026 07:52:05")).toBe("2026-11-18 07:52:05");
    expect(accurateDate("17/11/2026")).toBe("2026-11-17");
    expect(accurateDate("")).toBeNull();
    expect(mapMutation({ id: 5, itemNo: "80801682", warehouseName: "Utama", transactionType: "DO", transactionNumber: "DO.2026.11.00227",
      transactionId: 106152, transactionDate: "17/11/2026", createDate: "18/11/2026 07:52:05", mutation: -24, itemCost: 0 })).toEqual({
      id: 5, item_no: "80801682", warehouse: "Utama", trans_type: "DO", trans_number: "DO.2026.11.00227", trans_id: 106152,
      trans_date: "2026-11-17", created_wib: "2026-11-18 07:52:05", qty: -24, item_cost: 0,
    });
    expect(mapMutation({ id: 6, itemNo: "", mutation: 1 })).toBeNull();
  });

  it("reads the whole 7-day window over several pages, then waits 2 hours", async () => {
    const s = setup();
    s.setRows(Array.from({ length: 150 }, (_, i) => row(i + 1, "24/11/2026 10:00:00")));
    expect(await s.step()).toMatchObject({ outcome: "finished", rows: 150, removed: 0 });
    expect(s.q("SELECT COUNT(*) n FROM stock_mutations")[0].n).toBe(150);
    expect(s.q("SELECT item_no, warehouse, trans_number, trans_date, created_wib, qty FROM stock_mutations WHERE accurate_id = 1")[0]).toEqual({
      item_no: "B-1", warehouse: "Utama", trans_number: "DO.1", trans_date: "2026-11-24", created_wib: "2026-11-24 10:00:00", qty: -2,
    });
    expect(await s.step(new Date(NOW.getTime() + 3_600_000))).toMatchObject({ outcome: "idle", calls: 0 });
  });

  it("keeps history Accurate no longer has; marks a recent row that vanished, never one near the 7-day edge", async () => {
    const s = setup();
    s.setRows([row(1, "18/11/2026 20:00:00"), row(2, "24/11/2026 10:00:00"), row(3, "24/11/2026 11:00:00")]);
    await s.step();
    // Two days later: row 1 fell out of Accurate's window, row 2 was deleted, row 4 is new, row 3 changed.
    s.setRows([row(3, "24/11/2026 11:00:00", { mutation: -5 }), row(4, "26/11/2026 09:00:00")]);
    expect(await s.step(new Date(NOW.getTime() + 2 * 86_400_000))).toMatchObject({ outcome: "finished", removed: 1 });
    expect(s.q("SELECT accurate_id, qty, removed_at IS NOT NULL AS removed FROM stock_mutations ORDER BY accurate_id")).toEqual([
      { accurate_id: 1, qty: -2, removed: 0 },
      { accurate_id: 2, qty: -2, removed: 1 },
      { accurate_id: 3, qty: -5, removed: 0 },
      { accurate_id: 4, qty: -2, removed: 0 },
    ]);
  });

  it("continues a pass in the next tick when the call budget runs out", async () => {
    const s = setup();
    s.setRows(Array.from({ length: 250 }, (_, i) => row(i + 1, "24/11/2026 10:00:00")));
    expect(await s.step(NOW, 1)).toMatchObject({ outcome: "progress", rows: 100 });
    expect(await s.step(NOW, 1)).toMatchObject({ outcome: "progress", rows: 100 });
    expect(await s.step(NOW, 1)).toMatchObject({ outcome: "finished", rows: 50 });
    expect(s.q("SELECT COUNT(*) n FROM stock_mutations")[0].n).toBe(250);
  });

  it("an Accurate refusal is stored as the error, frees the lock, and the next tick retries", async () => {
    const s = setup();
    s.setRows([row(1, "24/11/2026 10:00:00")]);
    s.setFail(true);
    const r = await s.step();
    expect(r.outcome).toBe("error");
    expect(s.q("SELECT last_error IS NOT NULL AS e, locked_until FROM accurate_mutation_state")[0]).toEqual({ e: 1, locked_until: null });
    s.setFail(false);
    expect(await s.step()).toMatchObject({ outcome: "finished", rows: 1 });
    expect(s.q("SELECT last_error FROM accurate_mutation_state")[0].last_error).toBeNull();
  });
});
