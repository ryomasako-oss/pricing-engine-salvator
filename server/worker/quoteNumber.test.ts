import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { nextQuoteNumber } from "./quoteService";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'r@x', 'R', 'x', 'rep')`);
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

const insert = (sqlite: DatabaseSync, number: string) =>
  sqlite
    .prepare("INSERT INTO quotes(number, assumptions, items, regions, meta, created_by) VALUES (?, '{}', '[]', '[]', '{}', 1)")
    .run(number);

describe("nextQuoteNumber", () => {
  const oct = new Date(2026, 9, 26);

  it("counts on past 999 in a month: the 1000th is followed by 1001, not 1000 again", async () => {
    const { sqlite, db } = freshDb();
    insert(sqlite, "HK/SIP/Q/2610/999");
    const thousandth = await nextQuoteNumber(db, oct);
    expect(thousandth).toBe("HK/SIP/Q/2610/1000");
    insert(sqlite, thousandth);
    expect(await nextQuoteNumber(db, oct)).toBe("HK/SIP/Q/2610/1001");
  });

  it("starts each month at 001 and ignores other months", async () => {
    const { sqlite, db } = freshDb();
    insert(sqlite, "HK/SIP/Q/2609/1500");
    expect(await nextQuoteNumber(db, oct)).toBe("HK/SIP/Q/2610/001");
    insert(sqlite, "HK/SIP/Q/2610/001");
    expect(await nextQuoteNumber(db, oct)).toBe("HK/SIP/Q/2610/002");
  });
});
