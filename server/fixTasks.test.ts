import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { INSERT_TASKS_SQL, TASKS_PER_STATEMENT, insertTasksParams } from "./fixTasks";
import { tasksFromUnmatched } from "../shared/fixTasks";

function db() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES(1, 'r@test.local', 'R', 'x', 'rep');
               INSERT INTO quotes(id, number, title, created_by, assumptions, items, regions, meta) VALUES(1, 'Q-1', 'T', 1, '{}', '[]', '[]', '{}');`);
  return sqlite;
}
const insert = (sqlite: DatabaseSync, names: string[]) => {
  const params = insertTasksParams(tasksFromUnmatched(1, names.map((name) => ({ name, qty: 1, uom: "Pcs", reason: "none" as const }))), null);
  for (const p of params) sqlite.prepare(INSERT_TASKS_SQL).run(...p);
  return params.length;
};
const count = (sqlite: DatabaseSync) => (sqlite.prepare("SELECT COUNT(*) AS n FROM fix_tasks WHERE status = 'open'").get() as { n: number }).n;

describe("INSERT_TASKS_SQL", () => {
  it("stores every field of the task", () => {
    const sqlite = db();
    insert(sqlite, ["Galon air"]);
    expect(sqlite.prepare("SELECT kind, quote_id, line_id, item_name, qty, uom, dedupe FROM fix_tasks").get()).toEqual({
      kind: "not_in_catalog", quote_id: 1, line_id: null, item_name: "Galon air", qty: 1, uom: "Pcs", dedupe: "not_in_catalog|1|name:galon air",
    });
  });

  it("keeps one open task for repeats within one call and across calls, and a new one after it is done", () => {
    const sqlite = db();
    insert(sqlite, ["Galon air", "GALON  air", "Map"]);
    insert(sqlite, ["galon air"]);
    expect(count(sqlite)).toBe(2);
    sqlite.exec("UPDATE fix_tasks SET status = 'done' WHERE item_name = 'Galon air'");
    insert(sqlite, ["Galon air"]);
    expect(count(sqlite)).toBe(2);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM fix_tasks").get() as { n: number }).n).toBe(3);
  });

  it(`sends ${TASKS_PER_STATEMENT} tasks per statement, so a 2000-row list is a handful of queries`, () => {
    const sqlite = db();
    const statements = insert(sqlite, Array.from({ length: 2000 }, (_, i) => `Item ${i}`));
    expect(statements).toBe(Math.ceil(2000 / TASKS_PER_STATEMENT));
    expect(count(sqlite)).toBe(2000);
  });
});
