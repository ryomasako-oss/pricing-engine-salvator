import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { forgetCatalogIndex, searchWithMeaning } from "./catalogSearchIndex";
import { indexCatalogPage } from "./catalogSemantic";

/* Lapis 2: items close in meaning join the word search, only when it is on and words find little. */

function setup(enabled = true) {
  forgetCatalogIndex();
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const add = sqlite.prepare("INSERT INTO catalog_items(code, name, uom, category) VALUES(?, ?, 'Pcs', ?)");
  add.run("G1", "UHU GLUE STICK 21G", "GENERAL");
  add.run("K1", "SIDU KERTAS A4 70GR", "GENERAL");
  add.run("M1", "ARTLINE WHITEBOARD MARKER EK-157", "ARTLINE");
  const upserted: string[] = [];
  const env = {
    DB: new D1DatabaseShim(sqlite) as unknown as D1Database,
    CATALOG_SEMANTIC_SEARCH: enabled ? "true" : undefined,
    AI: { run: vi.fn(async (_m: string, input: { text: string[] }) => ({ data: input.text.map(() => [0.1, 0.2]) })) },
    CATALOG_VECTORS: {
      query: vi.fn(async () => ({ matches: [{ id: "G1", score: 0.82 }, { id: "K1", score: 0.6 }, { id: "M1", score: 0.3 }] })),
      upsert: vi.fn(async (v: { id: string }[]) => (upserted.push(...v.map((x) => x.id)), { mutationId: "x" })),
    },
  } as never;
  return { env, upserted };
}

describe("searchWithMeaning", () => {
  it("adds items close in meaning when no word matches, above the score floor only", async () => {
    const { env } = setup();
    // "perekat" is no catalog word and has no synonym: only meaning finds the glue (and paper, above
    // the floor); the marker scores under it.
    const r = await searchWithMeaning(env, "perekat");
    expect(r.items.map((d) => d.code)).toEqual(["G1", "K1"]);
    expect(r.byMeaning).toBe(2);
  });

  it("keeps word matches first and skips the AI when words find enough", async () => {
    const { env } = setup();
    const r = await searchWithMeaning(env, "lem");
    // "lem" = GLUE by synonym; meaning only adds K1 after it.
    expect(r.items.map((d) => d.code)).toEqual(["G1", "K1"]);
  });

  it("does nothing when switched off", async () => {
    const { env } = setup(false);
    const r = await searchWithMeaning(env, "perekat");
    expect(r.items).toEqual([]);
    expect(r.byMeaning).toBe(0);
  });
});

describe("indexCatalogPage", () => {
  it("embeds a page of items and says where the next page starts", async () => {
    const { env, upserted } = setup();
    expect(await indexCatalogPage(env, 0, 2)).toEqual({ indexed: 2, next: 2 });
    expect(await indexCatalogPage(env, 2, 2)).toEqual({ indexed: 1, next: null });
    expect(upserted.sort()).toEqual(["G1", "K1", "M1"]);
  });
});

describe("vectorTick", () => {
  it("fills the index once, then only again after the catalog's items change", async () => {
    const { env, upserted } = setup();
    const { vectorTick } = await import("./catalogSemantic");
    expect(await vectorTick(env)).toEqual({ outcome: "indexed", offset: null });
    expect(upserted.sort()).toEqual(["G1", "K1", "M1"]);
    expect((await vectorTick(env)).outcome).toBe("idle");
    // A stock change doesn't refill; a new item does.
    const db = (env as unknown as { DB: D1Database }).DB;
    await db.prepare("UPDATE catalog_items SET stock = 99").run();
    expect((await vectorTick(env)).outcome).toBe("idle");
    await db.prepare("INSERT INTO catalog_items(code, name, uom) VALUES('N1', 'NEW ITEM', 'Pcs')").run();
    expect((await vectorTick(env)).outcome).toBe("indexed");
  });

  it("does nothing when switched off", async () => {
    const { env, upserted } = setup(false);
    const { vectorTick } = await import("./catalogSemantic");
    expect((await vectorTick(env)).outcome).toBe("idle");
    expect(upserted).toEqual([]);
  });
});
