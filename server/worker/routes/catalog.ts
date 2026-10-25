import { Hono } from "hono";
import { z } from "zod";
import { all, get, run, stmt, batch } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { hasPermission } from "../../../shared/permissions";
import { PAUSE_NEW_ITEMS_SQL } from "../accurate/newItems";
import { catalogRowSchema, unitsSchema, zodMessage } from "../../validate";
import {
  type AliasRow,
  GLOBAL_ALIAS_DENIED,
  MATCH_COLUMNS,
  aliasInput,
  cleanAliasPairs,
  matchInput,
  matchResponse,
  mayStoreAlias,
  runMatch,
  MATCH_ALIASES_SQL,
} from "../../catalogMatch";
import { VERIFY_COGS_SQL, cogsCheckInput, withProblems } from "../../cogsCheck";
import {
  COUNTS_SQL, INSERT_FEEDBACK_SQL, MISSED_SQL, REJECTED_SQL, TOP_MISSED, WEEKS_SQL,
  buildReport, feedbackRows, feedbackSchema, rejectedMap,
} from "../../matchLearning";
import { cogsProblemsFor } from "../quoteService";
import { sweepPending } from "./pendingItems";
import { catalogEntity } from "../accurate/sync";
import { canSeeCosts, catalogItemsForViewer, problemsForViewer } from "../../staffView";
import { cleanUnits, type ItemUnits } from "../../../shared/uom";
import { chunks } from "../../sqlParams";
import type { CatalogItem, UnitFactor } from "../../../shared/types";
import type { Env } from "../env";

export const catalogRouter = new Hono<Env>();
catalogRouter.use(requireAuth);

const CHUNK = 90;

/** Extra units per code, for the given codes. */
async function unitsByCode(db: D1Database, codes: string[]): Promise<Map<string, UnitFactor[]>> {
  const map = new Map<string, UnitFactor[]>();
  for (const chunk of chunks(codes, CHUNK)) {
    const rows = await all<{ code: string; uom: string; factor: number }>(
      db,
      `SELECT code, uom, factor FROM catalog_item_uoms
        WHERE code IN (${chunk.map(() => "?").join(",")}) ORDER BY factor`,
      ...chunk,
    );
    for (const r of rows) {
      if (!map.has(r.code)) map.set(r.code, []);
      map.get(r.code)!.push({ uom: r.uom, factor: r.factor });
    }
  }
  return map;
}

/** Statements that replace one item's extra units, for inclusion in a batch. */
function replaceUnitsStmts(db: D1Database, code: string, baseUom: string | undefined, units: UnitFactor[]) {
  return [
    stmt(db, "DELETE FROM catalog_item_uoms WHERE code = ?", code),
    ...cleanUnits(baseUom, units).map((u) =>
      stmt(db, "INSERT INTO catalog_item_uoms(code, uom, factor) VALUES(?, ?, ?)", code, u.uom, u.factor),
    ),
  ];
}

catalogRouter.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const withCogs = c.req.query("withCogs") === "1";

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    where.push("(name LIKE ? OR code LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (withCogs) where.push("cogs > 0");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sortColumns: Record<string, string> = {
    name: "name",
    code: "code",
    stock: "stock",
    cogs: "cogs",
    list_price: "list_price",
  };
  // Sorting by COGS would tell staff which items cost more (PE-1).
  const sortKey = c.req.query("sortBy") ?? "";
  const sortField = (sortKey === "cogs" && !canSeeCosts(c.get("user")!.role) ? undefined : sortColumns[sortKey]) ?? "name";
  const sortDir = (c.req.query("sortDir") ?? "").toLowerCase() === "desc" ? "DESC" : "ASC";
  const orderBy = sortField === "name" ? "name" : `${sortField} ${sortDir}, name`;

  const total = await get<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM catalog_items ${clause}`, ...params);
  const items = await all<CatalogItem>(
    c.env.DB,
    `SELECT * FROM catalog_items ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  const codes = items.map((i) => i.code);
  const units = await unitsByCode(c.env.DB, codes);
  const withUnits = items.map((i) => ({ ...i, units: units.get(i.code) ?? [] }));
  const role = c.get("user")!.role;
  return c.json({
    items: catalogItemsForViewer(role, withProblems(withUnits, await cogsProblemsFor(c.env.DB, codes))),
    total: total?.n ?? 0,
  });
});

/**
 * Base unit + extra units for the codes on a quote, so the editor can convert
 * COGS/RRP when a line's unit changes. Codes not in the catalog are omitted.
 */
catalogRouter.post("/units", async (c) => {
  const parsed = z
    .object({ codes: z.array(z.string().trim().min(1).max(64)).max(2000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const codes = [...new Set(parsed.data.codes)];
  const out: Record<string, ItemUnits> = {};
  for (const chunk of chunks(codes, CHUNK)) {
    const bases = await all<{ code: string; uom: string }>(
      c.env.DB,
      `SELECT code, uom FROM catalog_items WHERE code IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
    );
    const units = await unitsByCode(c.env.DB, bases.map((b) => b.code));
    for (const b of bases) out[b.code] = { baseUom: b.uom, units: units.get(b.code) ?? [] };
  }
  return c.json({ units: out });
});

/**
 * Matches a client's request list to catalog items (code, learned alias, then
 * name similarity). Read-only: the rep reviews the result before any quote is
 * created, and prices always come from these catalog rows.
 */
catalogRouter.post("/match", async (c) => {
  const parsed = matchInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const catalog = await all<CatalogItem>(c.env.DB, `SELECT ${MATCH_COLUMNS} FROM catalog_items`);
  const aliases = await all<AliasRow>(c.env.DB, MATCH_ALIASES_SQL, parsed.data.client_id ?? 0, parsed.data.client_id ?? 0);
  // Pairings the reps already corrected away never come back as a certainty
  // (shared/matchLearning.ts). Read across clients: a bad guess is usually bad for all.
  const rejected = rejectedMap(await all<{ text: string; suggested: string }>(c.env.DB, REJECTED_SQL));
  const { results, referenced } = runMatch(parsed.data, catalog, aliases, rejected);
  const codes = referenced.map((i) => i.code);
  const body = matchResponse(results, referenced, await unitsByCode(c.env.DB, codes));
  const role = c.get("user")!.role;
  return c.json({ ...body, items: catalogItemsForViewer(role, withProblems(body.items, await cogsProblemsFor(c.env.DB, codes))) });
});

/** Which of these codes have a COGS that must not be sold on (shared/cogsCheck.ts). */
catalogRouter.post("/cogs-check", async (c) => {
  const parsed = cogsCheckInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const role = c.get("user")!.role;
  return c.json({ problems: Object.fromEntries(problemsForViewer(role, await cogsProblemsFor(c.env.DB, parsed.data.codes))) });
});

/** A manager confirms an item's current COGS is right despite a big jump from its history. */
catalogRouter.post("/:id/verify-cogs", requirePermission("edit_catalog"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const item = await get<CatalogItem>(c.env.DB, "SELECT * FROM catalog_items WHERE id = ?", id);
  if (!item) return c.json({ error: "Item tidak ditemukan." }, 404);
  if (!(item.cogs > 0)) return c.json({ error: "COGS item ini kosong; isi dulu sebelum ditandai sudah dicek." }, 400);
  await run(c.env.DB, VERIFY_COGS_SQL, item.code, item.cogs);
  await audit(c.env.DB, user.id, "catalog", id, "cogs_verified", { code: item.code, cogs: item.cogs });
  const problems = await cogsProblemsFor(c.env.DB, [item.code]);
  return c.json({ code: item.code, reference: item.cogs, cogs_problem: problems.get(item.code) ?? null });
});

/** Remembers which catalog item a client's wording means, for the next list. */
catalogRouter.post("/aliases", async (c) => {
  const user = c.get("user")!;
  const parsed = aliasInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const clientId = parsed.data.client_id ?? 0;
  // The permission is about storing a RULE. Recording what happened is an
  // observation anyone reviewing a list may leave, with or without a client.
  if (parsed.data.pairs.length && !mayStoreAlias(user.role, clientId)) return c.json({ error: GLOBAL_ALIAS_DENIED }, 403);
  if (clientId && !(await get(c.env.DB, "SELECT id FROM clients WHERE id = ?", clientId))) {
    return c.json({ error: "Klien tidak ditemukan." }, 400);
  }
  const codes = [...new Set(parsed.data.pairs.map((p) => p.code))];
  const found: { code: string }[] = [];
  for (const chunk of chunks(codes, CHUNK)) {
    found.push(
      ...(await all<{ code: string }>(
        c.env.DB,
        `SELECT code FROM catalog_items WHERE code COLLATE NOCASE IN (${chunk.map(() => "?").join(",")})`,
        ...chunk,
      )),
    );
  }
  const { pairs, unknown } = cleanAliasPairs(parsed.data.pairs, found.map((f) => f.code));
  if (unknown.length) return c.json({ error: `Kode tidak ada di katalog: ${unknown.slice(0, 5).join(", ")}` }, 400);
  if (pairs.length) {
    await batch(
      c.env.DB,
      pairs.map((p) =>
        stmt(
          c.env.DB,
          `INSERT INTO catalog_aliases(alias, client_id, code, created_by) VALUES(?, ?, ?, ?)
           ON CONFLICT(alias, client_id) DO UPDATE SET code = excluded.code,
             created_by = excluded.created_by, updated_at = datetime('now')`,
          p.alias,
          clientId,
          p.code,
          user.id,
        ),
      ),
    );
  }
  // Every reviewed row is recorded, right or wrong: the alias above is the rule,
  // this is the evidence. It is why a report can exist at all.
  const feedback = feedbackRows({ client_id: clientId, rows: parsed.data.feedback ?? [] }, user.id);
  if (feedback.length) await run(c.env.DB, INSERT_FEEDBACK_SQL, JSON.stringify(feedback));
  await audit(c.env.DB, user.id, "catalog", 0, "aliases_saved", { client_id: clientId, count: pairs.length, feedback: feedback.length });
  return c.json({ saved: pairs.length, recorded: feedback.length });
});

/**
 * How well the matcher is doing and what it keeps missing
 * (shared/matchLearning.ts). Costs: it reads the judged rows of the last 10
 * weeks, so it is a manager action, never part of matching.
 */
catalogRouter.get("/match-learning", requirePermission("import_catalog"), async (c) => {
  const [counts, weeks, missed, aliases, rejected] = await batch(c.env.DB, [
    stmt(c.env.DB, COUNTS_SQL),
    stmt(c.env.DB, WEEKS_SQL),
    stmt(c.env.DB, MISSED_SQL, TOP_MISSED),
    stmt(c.env.DB, "SELECT COUNT(*) AS n FROM catalog_aliases"),
    stmt(c.env.DB, `SELECT COUNT(*) AS n FROM (${REJECTED_SQL})`),
  ]);
  const one = (r: { results: unknown[] }) => Number((r.results[0] as { n: number } | undefined)?.n ?? 0);
  return c.json(
    buildReport({
      counts: counts.results as { outcome: string; n: number }[],
      weeks: weeks.results as { created_at: string; outcome: string }[],
      missed: missed.results as never,
      aliases: one(aliases),
      rejectedPairs: one(rejected),
    }),
  );
});

/** Managed UOM list — any manager/admin can extend it. Per-item ratios live in catalog_item_uoms. */
catalogRouter.get("/uom", async (c) => {
  const options = await all<{ id: number; name: string }>(c.env.DB, "SELECT id, name FROM uom_options ORDER BY name");
  return c.json({ options });
});

catalogRouter.post("/uom", requirePermission("edit_catalog"), async (c) => {
  const user = c.get("user")!;
  const parsed = z
    .object({ name: z.string().trim().min(1).max(32) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);

  const existing = await get<{ id: number }>(c.env.DB, "SELECT id FROM uom_options WHERE name = ?", parsed.data.name);
  if (existing) return c.json({ error: "Satuan ini sudah ada." }, 409);

  const info = await run(c.env.DB, "INSERT INTO uom_options(name) VALUES(?)", parsed.data.name);
  await audit(c.env.DB, user.id, "catalog", 0, "uom_added", { name: parsed.data.name });
  return c.json({ option: { id: Number(info.meta.last_row_id), name: parsed.data.name } }, 201);
});

catalogRouter.get("/stats", async (c) => {
  const stats = await get<{ total: number; priced: number; withList: number; updated: string | null }>(
    c.env.DB,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN cogs > 0 THEN 1 ELSE 0 END) AS priced,
            SUM(CASE WHEN list_price > 0 THEN 1 ELSE 0 END) AS withList,
            MAX(updated_at) AS updated
       FROM catalog_items`,
  );
  return c.json({ stats });
});

/**
 * Bulk upsert from a parsed spreadsheet. The client does the XLSX parsing and
 * posts plain rows, so the server never handles uploaded binaries.
 * Zero-valued fields never overwrite an existing non-zero value.
 *
 * D1 has no interactive transactions (only atomic batch() of pre-bound
 * writes), so this can't do the Node version's per-row
 * read-then-decide-then-write. Instead every row becomes a single
 * INSERT ... ON CONFLICT DO UPDATE statement that encodes the same
 * "zero/empty never overwrites" fallback logic in SQL, and to still
 * report accurate inserted/updated counts, existing codes are read
 * once up front (not interleaved with the writes).
 */
catalogRouter.post("/import", requirePermission("import_catalog"), async (c) => {
  const user = c.get("user")!;
  const parsed = z
    .object({
      rows: z.array(catalogRowSchema).min(1).max(20000),
      source: z.string().max(200).default("import"),
      mode: z.enum(["merge", "replace"]).default("merge"),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { rows, source, mode } = parsed.data;
  const replace = mode === "replace";
  // Replace deletes every item not in the file, the same effect as DELETE /catalog, so the same gate.
  if (replace && !hasPermission(user.role, "delete_catalog")) {
    return c.json({ error: "Mengganti seluruh katalog hanya bisa dilakukan admin. Pakai impor gabung." }, 403);
  }

  const codes = [...new Set(rows.map((r) => r.code.trim()).filter(Boolean))];
  if (replace && !codes.length) return c.json({ error: "File tidak berisi kode barang." }, 400);
  // code -> current base unit, so units can be cleaned against it when a
  // row doesn't send its own uom.
  const existing = new Map<string, string>();
  for (const chunk of chunks(codes, CHUNK)) {
    const placeholders = chunk.map(() => "?").join(",");
    const found = await all<{ code: string; uom: string }>(
      c.env.DB,
      `SELECT code, uom FROM catalog_items WHERE code IN (${placeholders})`,
      ...chunk,
    );
    for (const f of found) existing.set(f.code, f.uom);
  }

  // COGS = harga pembelian terakhir (Ryoma, 2026-10-15): an existing item with a priced
  // Accurate goods receipt takes its COGS from POST /api/accurate/apply-cogs, so a
  // spreadsheet (the Nilai Persediaan average) must not overwrite it. Other fields still update.
  const purchased = new Set<string>();
  const entity = catalogEntity(c.env);
  for (const chunk of chunks([...existing.keys()], CHUNK - 1)) {
    const found = await all<{ item_code: string }>(
      c.env.DB,
      `SELECT DISTINCT item_code FROM accurate_receipt_lines
        WHERE entity = ? AND unit_price > 0 AND quantity > 0 AND item_code IN (${chunk.map(() => "?").join(",")})`,
      entity,
      ...chunk,
    );
    for (const f of found) purchased.add(f.item_code);
  }

  // ?9 is NULL for a purchased item (its COGS stays); ?10 = 1 in replace mode,
  // where the file wins and a 0 or blank is written as such. A blank unit keeps
  // the current one in both modes, so the item's unit ratios stay valid.
  const UPSERT = `
    INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category, source)
    VALUES (
      ?1, ?2, COALESCE(NULLIF(?3, ''), 'Pcs'), ?4, ?5, COALESCE(?6, 0), ?7, ?8
    )
    ON CONFLICT(code) DO UPDATE SET
      name = ?2,
      uom = CASE WHEN ?3 != '' THEN ?3 ELSE catalog_items.uom END,
      cogs = CASE WHEN ?9 IS NULL THEN catalog_items.cogs WHEN ?9 > 0 OR ?10 = 1 THEN ?9 ELSE catalog_items.cogs END,
      list_price = CASE WHEN ?5 > 0 OR ?10 = 1 THEN ?5 ELSE catalog_items.list_price END,
      stock = CASE WHEN ?10 = 1 THEN COALESCE(?6, 0) ELSE COALESCE(?6, catalog_items.stock) END,
      category = CASE WHEN ?7 != '' OR ?10 = 1 THEN ?7 ELSE catalog_items.category END,
      source = ?8,
      updated_at = datetime('now')`;

  let inserted = 0;
  let updated = 0;
  let cogsFromPurchases = 0;
  const validRows = rows.filter((r) => r.code.trim());
  for (const chunk of chunks(validRows, CHUNK)) {
    const statements = chunk.flatMap((r) => {
      const code = r.code.trim();
      if (!existing.has(code)) inserted++;
      else updated++;
      const keepCogs = purchased.has(code) && (r.cogs ?? 0) > 0;
      if (keepCogs) cogsFromPurchases++;
      return [
        stmt(
          c.env.DB,
          UPSERT,
          code,
          r.name,
          r.uom ?? "",
          r.cogs ?? 0,
          r.list_price ?? 0,
          r.stock ?? null,
          r.category ?? "",
          source,
          purchased.has(code) ? null : (r.cogs ?? 0),
          replace ? 1 : 0,
        ),
        ...(r.units
          ? replaceUnitsStmts(c.env.DB, code, r.uom || existing.get(code) || "Pcs", r.units)
          : []),
      ];
    });
    await batch(c.env.DB, statements);
  }

  // Deleted last, so a failure part-way leaves the old catalog rather than half of the new one.
  let removed = 0;
  if (replace) {
    const keep = JSON.stringify(codes);
    const [, gone] = await batch(c.env.DB, [
      stmt(c.env.DB, "DELETE FROM catalog_item_uoms WHERE code NOT IN (SELECT value FROM json_each(?))", keep),
      stmt(c.env.DB, "DELETE FROM catalog_items WHERE code NOT IN (SELECT value FROM json_each(?))", keep),
      stmt(c.env.DB, PAUSE_NEW_ITEMS_SQL, user.id),
    ]);
    removed = gone.meta.changes;
  }

  const result = { inserted, updated, cogsFromPurchases, ...(replace && { removed }) };
  await audit(c.env.DB, user.id, "catalog", 0, "imported", { ...result, source, mode, rows: rows.length });
  // Barang baru requests whose code this import brought into the catalog are linked, and their tasks closed.
  await sweepPending(c.env.DB);
  return c.json({ ...result, total: rows.length });
});

catalogRouter.put("/:id", requirePermission("edit_catalog"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = z
    .object({
      name: z.string().min(1).max(300),
      uom: z.string().max(32),
      cogs: z.number().min(0),
      list_price: z.number().min(0),
      category: z.string().max(120).default(""),
      units: unitsSchema.optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const d = parsed.data;
  const code = (await get<{ code: string }>(c.env.DB, "SELECT code FROM catalog_items WHERE id = ?", id))?.code;
  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      `UPDATE catalog_items SET name = ?, uom = ?, cogs = ?, list_price = ?, category = ?,
              updated_at = datetime('now') WHERE id = ?`,
      d.name, d.uom, d.cogs, d.list_price, d.category, id,
    ),
    ...(code && d.units ? replaceUnitsStmts(c.env.DB, code, d.uom, d.units) : []),
  ]);
  await audit(c.env.DB, user.id, "catalog", id, "updated", d);
  const item = await get<CatalogItem>(c.env.DB, "SELECT * FROM catalog_items WHERE id = ?", id);
  const units = item ? (await unitsByCode(c.env.DB, [item.code])).get(item.code) ?? [] : [];
  return c.json({ item: item && { ...item, units } });
});

catalogRouter.delete("/", requirePermission("delete_catalog"), async (c) => {
  const user = c.get("user")!;
  const [, info] = await batch(c.env.DB, [
    stmt(c.env.DB, "DELETE FROM catalog_item_uoms"),
    stmt(c.env.DB, "DELETE FROM catalog_items"),
    stmt(c.env.DB, PAUSE_NEW_ITEMS_SQL, user.id),
  ]);
  await audit(c.env.DB, user.id, "catalog", 0, "cleared", { removed: info.meta.changes });
  return c.json({ ok: true, removed: info.meta.changes });
});
