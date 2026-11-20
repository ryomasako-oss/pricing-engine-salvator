import { Hono } from "hono";
import { z } from "zod";
import { all, get, run, stmt, batch } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { hasPermission } from "../../../shared/permissions";
import { PAUSE_NEW_ITEMS_SQL } from "../accurate/newItems";
import { STOCK_AS_OF_KEY } from "../accurate/stock";
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
import { costLines } from "../accurate/receipts";
import { searchCatalog } from "../../../shared/catalogSearch";
import { catalogIndex, forgetCatalogIndex, recordPicks, saveSearchPriority, searchPriority, searchWithMeaning, type IndexedItem } from "../catalogSearchIndex";
import { indexCatalogPage } from "../catalogSemantic";
import { lastSales, salesEnabled, salesNameMap, soldCounts } from "../accurate/sales";
import { rerankCandidates } from "../../../shared/matchRank";
import { isPriorityBrand } from "../../../shared/priorityBrands";
import { normalizeText } from "../../../shared/match";
import { canSeeCosts, catalogItemsForViewer, problemsForViewer } from "../../staffView";
import { cleanUnits, sameUom, type ItemUnits } from "../../../shared/uom";
import { NO_CHANGE, draftChanges, type DraftPayloads } from "../../../shared/catalogDrafts";
import { chunks } from "../../sqlParams";
import { importNext, importUnchanged, type ImportItem, type ImportMode, type ImportRow } from "../../../shared/catalogImport";
import { barcodeOwner, barcodesByCode, draftsByCode, nextInternalBarcode, proposalsByCode, takenMessage } from "../unitBarcodes";
import { refreshItemImagesIfStale } from "../itemImages";
import { itemImageUrl } from "../../../shared/itemImages";
import type { CatalogDraftMark, CatalogItem, Role, UnitFactor } from "../../../shared/types";
import type { Env } from "../env";

export const catalogRouter = new Hono<Env>();
catalogRouter.use(requireAuth);
// A catalog write: the next search in this isolate rebuilds its index (catalogSearchIndex.ts). POSTs that
// only read (matching, units, the COGS check) or only record a search pick leave it alone: a rebuild reads
// the whole catalog, a year of SI/PI and every quote.
const READ_ONLY_POSTS = /\/(match|units|cogs-check|search-picks)\/?$/;
catalogRouter.use(async (c, next) => {
  await next();
  if (c.req.method !== "GET" && c.res.status < 400 && !READ_ONLY_POSTS.test(c.req.path)) forgetCatalogIndex();
});

const searchPriorityInput = z.object({ priority: z.array(z.string().trim().min(1).max(80)).max(12) });

/** Pengaturan › Pencarian: the priority categories, and every category to choose from. */
catalogRouter.get("/search-settings", async (c) => {
  const categories = await all<{ category: string; items: number }>(
    c.env.DB,
    "SELECT category, COUNT(*) AS items FROM catalog_items WHERE category != '' GROUP BY category ORDER BY items DESC, category",
  );
  return c.json({ priority: await searchPriority(c.env.DB), categories });
});

const searchPicksInput = z.object({ q: z.string().trim().min(1).max(200), codes: z.array(z.string().min(1).max(64)).min(1).max(50) });

/** Learn from habit: these items were picked after typing `q` (shared/catalogSearch.ts). */
catalogRouter.post("/search-picks", async (c) => {
  const parsed = searchPicksInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  // Only codes that are in the catalog: a made-up code would sit in the table and rank nothing.
  const codes = [...new Set(parsed.data.codes)];
  const known = await all<{ code: string }>(c.env.DB, `SELECT code FROM catalog_items WHERE code IN (${codes.map(() => "?").join(",")})`, ...codes);
  if (known.length) await recordPicks(c.env.DB, parsed.data.q, known.map((k) => k.code));
  return c.json({ ok: true });
});

/** Pencarian AI: embed one page of the catalog into the Vectorize index; call again with `next` until null. */
catalogRouter.post("/search-index", requirePermission("manage_company"), async (c) => {
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 500));
  if (!c.env.AI || !c.env.CATALOG_VECTORS) return c.json({ error: "Pencarian AI belum dipasang (binding AI dan CATALOG_VECTORS)." }, 503);
  const r = await indexCatalogPage(c.env, offset, limit);
  await audit(c.env.DB, c.get("user")!.id, "catalog", 0, "search_index_page", { offset, ...r });
  return c.json(r);
});

catalogRouter.put("/search-settings", requirePermission("edit_catalog"), async (c) => {
  const parsed = searchPriorityInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const priority = [...new Set(parsed.data.priority)];
  await saveSearchPriority(c.env.DB, priority);
  await audit(c.env.DB, c.get("user")!.id, "settings", 0, "search_priority_updated", { priority });
  return c.json({ priority });
});

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

/**
 * Statements that replace one item's extra units, for inclusion in a batch. A unit that stays keeps its
 * `manual` mark; a new one is manual, so Accurate's "Terapkan" leaves it alone (migrations/0039).
 */
function replaceUnitsStmts(db: D1Database, code: string, baseUom: string | undefined, units: UnitFactor[]) {
  const clean = cleanUnits(baseUom, units);
  return [
    stmt(
      db,
      "DELETE FROM catalog_item_uoms WHERE code = ? AND lower(uom) NOT IN (SELECT lower(value) FROM json_each(?))",
      code,
      JSON.stringify(clean.map((u) => u.uom)),
    ),
    ...clean.map((u) =>
      stmt(
        db,
        `INSERT INTO catalog_item_uoms(code, uom, factor, manual) VALUES(?, ?, ?, 1)
         ON CONFLICT(code, uom) DO UPDATE SET factor = excluded.factor`,
        code, u.uom, u.factor,
      ),
    ),
  ];
}

/** URL gambar untuk kode yang punya gambar di storage sendiri (lihat shared/itemImages.ts). */
async function imagesByCode(d1: D1Database, codes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunks(codes, CHUNK)) {
    const rows = await all<{ code: string }>(
      d1,
      `SELECT code FROM item_images WHERE code IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
    );
    for (const r of rows) map.set(r.code, itemImageUrl(r.code));
  }
  return map;
}

catalogRouter.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const withCogs = c.req.query("withCogs") === "1";

  // Daftar kode bergambar sudah basi? Perbarui sekalian (bucket R2).
  await refreshItemImagesIfStale(c.env);

  // Filter gambar: "with" = punya gambar, "without" = belum. Kode lain diabaikan (sama dengan "semua").
  const imageFilter = c.req.query("image");
  const sortColumns: Record<string, keyof IndexedItem> = {
    name: "name",
    code: "code",
    stock: "stock",
    cogs: "cogs",
    list_price: "list_price",
  };
  // Sorting by COGS would tell staff which items cost more (PE-1).
  const sortKey = c.req.query("sortBy") ?? "";
  const sortField = sortKey === "cogs" && !canSeeCosts(c.get("user")!.role) ? undefined : sortColumns[sortKey];
  const desc = (c.req.query("sortDir") ?? "").toLowerCase() === "desc";

  let items: CatalogItem[];
  let total: number;
  // Exact codes (a reopened draft's picks): no search ranking, up to 90 at once.
  const exact = (c.req.query("codes") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 90);
  let suggestion: string | null = null;
  let partial = false;
  let byMeaning = 0;
  if (exact.length) {
    items = await all<CatalogItem>(c.env.DB, `SELECT * FROM catalog_items WHERE code COLLATE NOCASE IN (${exact.map(() => "?").join(",")})`, ...exact);
    total = items.length;
  } else if (q) {
    // Ala mesin cari (shared/catalogSearch.ts): ranked by relevance unless a column sort is asked for.
    const found = await searchWithMeaning(c.env, q);
    suggestion = found.suggestion;
    partial = found.partial;
    byMeaning = found.byMeaning;
    let rows = found.items.filter(
      (r) => (!withCogs || r.cogs > 0) && (imageFilter === "with" ? r.has_image : imageFilter === "without" ? !r.has_image : true),
    );
    if (sortField) {
      const dir = desc ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = a[sortField];
        const y = b[sortField];
        const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return dir * cmp || a.name.localeCompare(b.name);
      });
    }
    total = rows.length;
    const page = rows.slice(offset, offset + limit).map((r) => r.code);
    const full = new Map<string, CatalogItem>();
    for (let i = 0; i < page.length; i += 90) {
      const chunk = page.slice(i, i + 90);
      for (const r of await all<CatalogItem>(c.env.DB, `SELECT * FROM catalog_items WHERE code IN (${chunk.map(() => "?").join(",")})`, ...chunk)) {
        full.set(r.code, r);
      }
    }
    items = page.map((code) => full.get(code)).filter((r): r is CatalogItem => !!r);
    // An item deleted since the index was built is not counted, so "load more" stops at the real end.
    total -= page.length - items.length;
  } else {
    const where: string[] = [];
    if (withCogs) where.push("cogs > 0");
    if (imageFilter === "with") where.push("code IN (SELECT code FROM item_images)");
    if (imageFilter === "without") where.push("code NOT IN (SELECT code FROM item_images)");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const field = sortField ?? "name";
    const orderBy = field === "name" ? `name ${desc ? "DESC" : "ASC"}` : `${field} ${desc ? "DESC" : "ASC"}, name`;
    total = (await get<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM catalog_items ${clause}`))?.n ?? 0;
    items = await all<CatalogItem>(c.env.DB, `SELECT * FROM catalog_items ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, limit, offset);
  }
  const codes = items.map((i) => i.code);
  const units = await unitsByCode(c.env.DB, codes);
  const barcodes = await barcodesByCode(c.env.DB, codes);
  const proposals = await proposalsByCode(c.env.DB, codes);
  const drafts = await draftsByCode(c.env.DB, codes);
  const withUnits = items.map((i) => ({
    ...i,
    units: units.get(i.code) ?? [],
    barcodes: barcodes.get(i.code) ?? [],
    unit_proposals: proposals.get(i.code) ?? [],
    drafts: drafts.get(i.code) ?? [],
  }));
  const images = await imagesByCode(c.env.DB, codes);
  const role = c.get("user")!.role;
  const visible = catalogItemsForViewer(role, withProblems(withUnits, await cogsProblemsFor(c.env.DB, codes)));
  const stockAsOf = await get<{ value: string }>(c.env.DB, "SELECT value FROM settings WHERE key = ?", STOCK_AS_OF_KEY);
  return c.json({
    items: visible.map((i) => ({ ...i, image: images.get(i.code) ?? null })),
    total,
    stockAsOf: stockAsOf?.value ?? null,
    suggestion,
    partial,
    byMeaning,
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
  // Opening a quote also warms the image list: the editor calls this directly.
  await refreshItemImagesIfStale(c.env);
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
  return c.json({ units: out, images: Object.fromEntries(await imagesByCode(c.env.DB, codes)) });
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
  // How the sales team invoiced each wording (accurate/sales.ts salesNameMap), for this client first.
  const customerNo = parsed.data.client_id
    ? ((await get<{ no: string }>(c.env.DB, "SELECT accurate_customer_no AS no FROM clients WHERE id = ?", parsed.data.client_id))?.no ?? "")
    : "";
  const siNames = salesEnabled(c.env)
    ? await salesNameMap(c.env.DB, catalogEntity(c.env), parsed.data.lines.map((l) => normalizeText(l.name)), customerNo)
    : undefined;
  const matched = runMatch(parsed.data, catalog, aliases, rejected, siNames);
  const { referenced } = matched;
  const codes = referenced.map((i) => i.code);
  // Near-equal suggestions: what sales sells, then in stock, then a priority brand (shared/matchRank.ts).
  const sold = salesEnabled(c.env) ? await soldCounts(c.env.DB, catalogEntity(c.env), codes) : new Map<string, number>();
  const results = rerankCandidates(
    matched.results,
    new Map(referenced.map((i) => [i.id, { sold: sold.get(i.code) ?? 0, inStock: Number(i.stock) > 0, priorityBrand: isPriorityBrand(i.name) }])),
  );
  const body = matchResponse(results, referenced, await unitsByCode(c.env.DB, codes));
  const role = c.get("user")!.role;
  // The price the client last paid is the default ceiling (accurate/sales.ts lastSales).
  const sales = salesEnabled(c.env)
    ? await lastSales(c.env.DB, catalogEntity(c.env), referenced, customerNo)
    : new Map();
  const items = body.items.map((i) => ({ ...i, last_sale: sales.get(i.code) ?? null }));
  return c.json({ ...body, items: catalogItemsForViewer(role, withProblems(items, await cogsProblemsFor(c.env.DB, codes))) });
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
  if (!(item.cogs > 0)) return c.json({ error: "COGS barang ini masih kosong. Isi dulu sebelum ditandai sudah dicek." }, 400);
  await run(c.env.DB, VERIFY_COGS_SQL, item.code, item.cogs);
  await audit(c.env.DB, user.id, "catalog", id, "cogs_verified", { code: item.code, cogs: item.cogs });
  const problems = await cogsProblemsFor(c.env.DB, [item.code]);
  return c.json({ code: item.code, reference: item.cogs, cogs_problem: problems.get(item.code) ?? null });
});

const barcodeText = z.string().trim().max(64).regex(/^[0-9A-Za-z-]*$/, "Barcode hanya boleh huruf, angka, dan tanda minus.");

/** The item and its SKUs: the base unit, the extra units, proposed units, and any unit that only still has a barcode. */
async function itemSkus(db: D1Database, id: number) {
  const item = await get<{ code: string; name: string; uom: string }>(db, "SELECT code, name, uom FROM catalog_items WHERE id = ?", id);
  if (!item) return null;
  const units = (await unitsByCode(db, [item.code])).get(item.code) ?? [];
  const barcodes = (await barcodesByCode(db, [item.code])).get(item.code) ?? [];
  const proposals = (await proposalsByCode(db, [item.code])).get(item.code) ?? [];
  const has = (uom: string) =>
    sameUom(uom, item.uom) || [...units, ...proposals, ...barcodes].some((u) => sameUom(u.uom, uom));
  return { ...item, units, barcodes, proposals, has };
}

const skuOut = async (db: D1Database, code: string) => ({
  units: (await unitsByCode(db, [code])).get(code) ?? [],
  barcodes: (await barcodesByCode(db, [code])).get(code) ?? [],
  proposals: (await proposalsByCode(db, [code])).get(code) ?? [],
  drafts: (await draftsByCode(db, [code])).get(code) ?? [],
});

/* Each catalog fix below is one function that either only checks (`apply` false: an Admin Gudang's save,
   which then becomes a draft) or checks and writes (a direct save, or an admin's ACC of that draft, `via`
   naming the draft and who drafted it in the audit). */
type Fail = { error: string; status: 400 | 404 | 409 };
const fail = (error: string, status: Fail["status"]): Fail => ({ error, status });
const failed = (r: object): r is Fail => "error" in r;
type Via = { draft_id: number; proposed_by: number | null };

async function setBarcode(
  db: D1Database, actorId: number, id: number, uomIn: string | undefined, barcode: string | null, apply: boolean, via?: Via,
): Promise<Fail | { code: string; uom: string; before: string | null }> {
  const item = await itemSkus(db, id);
  if (!item) return fail("Item tidak ditemukan.", 404);
  const uom = uomIn ?? item.uom;
  if (!item.has(uom)) return fail(`Satuan ${uom} belum ada di barang ini. Tambah satuannya dulu.`, 400);
  const before = item.barcodes.find((b) => sameUom(b.uom, uom))?.barcode ?? null;
  const done = { code: item.code, uom, before };
  if (before === barcode) return done;
  if (barcode) {
    const other = await barcodeOwner(db, barcode);
    if (other) return fail(takenMessage(barcode, other), 409);
  }
  if (!apply) return done;
  if (barcode) {
    await run(
      db,
      `INSERT INTO catalog_unit_barcodes(code, uom, barcode, generated) VALUES(?, ?, ?, 0)
       ON CONFLICT(code, uom) DO UPDATE SET barcode = excluded.barcode, generated = 0, updated_at = datetime('now')`,
      item.code, uom, barcode,
    );
  } else {
    await run(db, "DELETE FROM catalog_unit_barcodes WHERE code = ? AND uom = ?", item.code, uom);
  }
  await audit(db, actorId, "catalog", id, "barcode_set", { code: item.code, uom, before, after: barcode, ...via });
  return done;
}

async function generateBarcode(
  db: D1Database, actorId: number, id: number, uomIn: string | undefined, apply: boolean, via?: Via,
): Promise<Fail | { code: string; uom: string }> {
  const item = await itemSkus(db, id);
  if (!item) return fail("Item tidak ditemukan.", 404);
  const uom = uomIn ?? item.uom;
  if (!item.has(uom)) return fail(`Satuan ${uom} belum ada di barang ini. Tambah satuannya dulu.`, 400);
  const existing = item.barcodes.find((b) => sameUom(b.uom, uom));
  if (existing) return fail(`${item.code} (${uom}) sudah punya barcode ${existing.barcode}.`, 409);
  if (!apply) return { code: item.code, uom };
  const barcode = await nextInternalBarcode(db);
  await run(db, "INSERT INTO catalog_unit_barcodes(code, uom, barcode, generated) VALUES(?, ?, ?, 1)", item.code, uom, barcode);
  await audit(db, actorId, "catalog", id, "barcode_set", { code: item.code, uom, before: null, after: barcode, generated: true, ...via });
  return { code: item.code, uom };
}

const unitInput = z.object({
  uom: z.string().trim().min(1).max(32),
  factor: z.number().positive("Isi harus lebih dari 0.").max(1_000_000),
  barcode: barcodeText.optional(),
  generate: z.boolean().optional(),
});

/** `direct` false: a rep's proposal for a manager (catalog_unit_proposals); true: the unit itself. */
async function addUnit(
  db: D1Database, actorId: number, id: number, d: z.infer<typeof unitInput>, direct: boolean, apply: boolean, via?: Via,
): Promise<Fail | { code: string; uom: string; base: string }> {
  const item = await itemSkus(db, id);
  if (!item) return fail("Item tidak ditemukan.", 404);
  if (sameUom(d.uom, item.uom) || item.units.some((u) => sameUom(u.uom, d.uom))) {
    return fail(`Satuan ${d.uom} sudah ada di barang ini. Isinya hanya bisa diubah lewat Ubah barang.`, 409);
  }
  if (item.proposals.some((u) => sameUom(u.uom, d.uom))) {
    return fail(`Satuan ${d.uom} sudah diusulkan dan menunggu persetujuan manager.`, 409);
  }
  if (item.units.length + item.proposals.length >= 10) return fail("Barang ini sudah punya 10 satuan tambahan.", 400);
  if (d.barcode) {
    const other = await barcodeOwner(db, d.barcode);
    if (other) return fail(takenMessage(d.barcode, other), 409);
  }
  // The list's own spelling when it already has this name in another case ("box" -> "Box").
  const option = await get<{ name: string }>(db, "SELECT name FROM uom_options WHERE name = ? COLLATE NOCASE", d.uom);
  const uom = option?.name ?? d.uom;
  if (!apply) return { code: item.code, uom, base: item.uom };
  const barcode = d.barcode || (d.generate ? await nextInternalBarcode(db) : null);
  await batch(db, [
    ...(option ? [] : [stmt(db, "INSERT INTO uom_options(name) VALUES(?)", uom)]),
    direct
      ? stmt(db, "INSERT INTO catalog_item_uoms(code, uom, factor, manual) VALUES(?, ?, ?, 1)", item.code, uom, d.factor)
      : stmt(db, "INSERT INTO catalog_unit_proposals(code, uom, factor, proposed_by) VALUES(?, ?, ?, ?)", item.code, uom, d.factor, actorId),
    // An orphan barcode left on this unit name (its ratio was removed) is replaced, not duplicated.
    ...(barcode
      ? [stmt(
          db,
          `INSERT INTO catalog_unit_barcodes(code, uom, barcode, generated) VALUES(?, ?, ?, ?)
           ON CONFLICT(code, uom) DO UPDATE SET barcode = excluded.barcode, generated = excluded.generated, updated_at = datetime('now')`,
          item.code, uom, barcode, d.barcode ? 0 : 1,
        )]
      : []),
  ]);
  if (!option) await audit(db, actorId, "catalog", 0, "uom_added", { name: uom });
  await audit(db, actorId, "catalog", id, direct ? "unit_added" : "unit_proposed", { code: item.code, uom, factor: d.factor, base: item.uom, barcode, ...via });
  return { code: item.code, uom, base: item.uom };
}

/**
 * Saves an Admin Gudang's checked change as a draft. A second save of the same SKU (or of the same item,
 * for Ubah barang) replaces the waiting one. A barcode already in another waiting draft is refused, so
 * two drafts can't both be ACCed onto one barcode.
 */
async function saveDraft(
  db: D1Database, userId: number,
  d: { item_id: number; code: string; kind: CatalogDraftMark["kind"]; uom: string; payload: Record<string, unknown>; before: Record<string, unknown> },
): Promise<Fail | null> {
  const barcode = typeof d.payload.barcode === "string" && d.payload.barcode ? d.payload.barcode : null;
  if (barcode) {
    const other = await get<{ code: string; uom: string }>(
      db,
      `SELECT code, uom FROM catalog_drafts WHERE status = 'pending' AND json_extract(payload, '$.barcode') = ?
          AND NOT (code = ? AND kind = ? AND uom = ?)`,
      barcode, d.code, d.kind, d.uom,
    );
    if (other) return fail(`Barcode ${barcode} sudah ada di draf lain (${other.code} ${other.uom}) yang menunggu ACC.`, 409);
  }
  await run(
    db,
    `INSERT INTO catalog_drafts(item_id, code, kind, uom, payload, before, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code, kind, uom) WHERE status = 'pending'
     DO UPDATE SET payload = excluded.payload, before = excluded.before, created_by = excluded.created_by, created_at = datetime('now')`,
    d.item_id, d.code, d.kind, d.uom, JSON.stringify(d.payload), JSON.stringify(d.before), userId,
  );
  await audit(db, userId, "catalog", d.item_id, "catalog_draft_submitted", { code: d.code, kind: d.kind, uom: d.uom, ...d.payload });
  return null;
}

/**
 * Stok (pemilik, 2026-11-20): every manual stock change, from any role, is a draft that applies only after an
 * admin's ACC. One waiting draft per item (a second save replaces it); the number is in the base unit.
 */
catalogRouter.put("/:id/stock", async (c) => {
  const user = c.get("user")!;
  if (!hasPermission(user.role, "draft_catalog") && !hasPermission(user.role, "edit_catalog")) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  const id = Number(c.req.param("id"));
  const parsed = z.object({ stock: z.number().min(0, "Stok tidak boleh minus.").max(1_000_000_000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const item = await get<{ code: string; stock: number }>(c.env.DB, "SELECT code, stock FROM catalog_items WHERE id = ?", id);
  if (!item) return c.json({ error: "Item tidak ditemukan." }, 404);
  if (item.stock === parsed.data.stock) return c.json({ error: "Stok sama dengan yang sekarang. Belum ada yang diubah." }, 400);
  const f = await saveDraft(c.env.DB, user.id, { item_id: id, code: item.code, kind: "stock", uom: "", payload: { stock: parsed.data.stock }, before: { stock: item.stock } });
  if (f) return c.json({ error: f.error }, f.status);
  return c.json(await skuOut(c.env.DB, item.code));
});

/** Admin Gudang: every catalog fix becomes a draft for an admin, nothing reaches the catalog itself. */
const drafting = (role: Role) => hasPermission(role, "draft_catalog") && !hasPermission(role, "edit_catalog");

/**
 * Barcode of one SKU (item + unit; the base unit when `uom` is left out), filled in by warehouse staff
 * from the packaging. Every logged-in role may set it (warehouse accounts are usually `rep`); it touches
 * no price. Clearing needs `clear: true` (the Hapus button), so an emptied box never wipes a saved barcode.
 * An Admin Gudang's change is saved as a draft.
 */
catalogRouter.put("/:id/barcode", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = z
    .object({ uom: z.string().trim().min(1).max(32).optional(), barcode: barcodeText, clear: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const barcode = parsed.data.barcode || null;
  if (!barcode && !parsed.data.clear) return c.json({ error: "Barcode masih kosong. Untuk menghapus barcode, pakai tombol Hapus barcode." }, 400);
  const draft = drafting(user.role);
  const r = await setBarcode(c.env.DB, user.id, id, parsed.data.uom, barcode, !draft);
  if (failed(r)) return c.json({ error: r.error }, r.status);
  if (draft && r.before !== barcode) {
    const f = await saveDraft(c.env.DB, user.id, { item_id: id, code: r.code, kind: "barcode", uom: r.uom, payload: { barcode }, before: { barcode: r.before } });
    if (f) return c.json({ error: f.error }, f.status);
  }
  return c.json(await skuOut(c.env.DB, r.code));
});

/** No barcode on the packaging: give the SKU an internal EAN-13 (prefix 20) to print as a label. */
catalogRouter.post("/:id/barcode/generate", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = z.object({ uom: z.string().trim().min(1).max(32).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const draft = drafting(user.role);
  const r = await generateBarcode(c.env.DB, user.id, id, parsed.data.uom, !draft);
  if (failed(r)) return c.json({ error: r.error }, r.status);
  // The number itself is picked at ACC time, so a waiting draft holds none back.
  if (draft) await saveDraft(c.env.DB, user.id, { item_id: id, code: r.code, kind: "barcode", uom: r.uom, payload: { generate: true }, before: { barcode: null } });
  return c.json(await skuOut(c.env.DB, r.code));
});

/**
 * Warehouse staff propose a unit the item does not have yet (e.g. 1 Lusin = 12 Pcs: factor 1/12), with its
 * barcode in the same step. A proposal does not reach quotes, which follow Accurate's units, until a
 * manager approves it (POST /:id/unit/review). A manager's own addition needs no review.
 * A unit name that is not in the list yet is added to it. An Admin Gudang's unit is a draft for an admin.
 */
catalogRouter.post("/:id/unit", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = unitInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const draft = drafting(user.role);
  const r = await addUnit(c.env.DB, user.id, id, parsed.data, hasPermission(user.role, "edit_catalog"), !draft);
  if (failed(r)) return c.json({ error: r.error }, r.status);
  if (draft) {
    const { factor, barcode, generate } = parsed.data;
    const f = await saveDraft(c.env.DB, user.id, {
      item_id: id, code: r.code, kind: "unit", uom: r.uom, payload: { factor, base: r.base, ...(barcode ? { barcode } : generate ? { generate: true } : {}) }, before: {},
    });
    if (f) return c.json({ error: f.error }, f.status);
  }
  return c.json(await skuOut(c.env.DB, r.code), 201);
});

/* ---------------- Draf Perbaikan Divisi Gudang ---------------- */

/** An admin sees every draft; an Admin Gudang only their own. Anyone else has no drafts page. */
const draftViewer = (role: Role) =>
  hasPermission(role, "review_catalog_drafts") ? "all" : hasPermission(role, "draft_catalog") ? "own" : null;

/** Waiting drafts (oldest first), or the reviewed / cancelled ones (newest first, last 200). */
catalogRouter.get("/drafts", async (c) => {
  const user = c.get("user")!;
  const viewer = draftViewer(user.role);
  if (!viewer) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  const done = c.req.query("status") === "done";
  const rows = await all<Record<string, unknown> & { payload: string; before: string }>(
    c.env.DB,
    `SELECT d.id, d.item_id, d.code, i.name, i.uom AS base_uom, d.kind, d.uom, d.payload, d.before, d.status, d.note,
            d.created_by, u.name AS created_by_name, d.created_at, r.name AS reviewed_by_name, d.reviewed_at
       FROM catalog_drafts d
       LEFT JOIN catalog_items i ON i.id = d.item_id
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN users r ON r.id = d.reviewed_by
      WHERE d.kind != 'import' AND ${done ? "d.status != 'pending'" : "d.status = 'pending'"} ${viewer === "own" ? "AND d.created_by = ?" : ""}
      ORDER BY ${done ? "COALESCE(d.reviewed_at, d.created_at) DESC, d.id DESC LIMIT 200" : "d.created_at, d.id"}`,
    ...(viewer === "own" ? [user.id] : []),
  );
  return c.json({ drafts: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload), before: JSON.parse(r.before) })) });
});

/** For the menu badge: drafts waiting (all of them for an admin, one's own for an Admin Gudang). */
catalogRouter.get("/drafts/count", async (c) => {
  const user = c.get("user")!;
  const viewer = draftViewer(user.role);
  if (!viewer) return c.json({ pending: 0 });
  const row = await get<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM catalog_drafts WHERE status = 'pending' ${viewer === "own" ? "AND created_by = ?" : ""}`,
    ...(viewer === "own" ? [user.id] : []),
  );
  return c.json({ pending: row?.n ?? 0 });
});

type DraftRow = { id: number; item_id: number; code: string; kind: CatalogDraftMark["kind"]; uom: string; payload: string; before: string; created_by: number | null; import_id?: number | null };

/**
 * An Ubah barang draft carries only what the Admin Gudang changed, laid over the item as it is now. Without
 * this, an older draft's full unit list would undo a unit ACCed after it was drafted.
 */
export function editOverCurrent(
  current: { name: string; uom: string; category: string; units: UnitFactor[] },
  before: { name?: string; uom?: string; category?: string; units?: UnitFactor[] },
  wanted: { name: string; uom: string; category: string; units?: UnitFactor[] },
) {
  const pick = <K extends "name" | "uom" | "category">(k: K) => (wanted[k] !== before[k] ? wanted[k] : current[k]);
  let units = current.units;
  if (wanted.units) {
    const was = before.units ?? [];
    const removed = was.filter((u) => !wanted.units!.some((w) => sameUom(w.uom, u.uom)));
    const changed = wanted.units.filter((w) => !was.some((u) => sameUom(u.uom, w.uom) && u.factor === w.factor));
    units = [
      ...current.units.filter((u) => !removed.some((r) => sameUom(r.uom, u.uom)) && !changed.some((c) => sameUom(c.uom, u.uom))),
      ...changed,
    ];
  }
  return { name: pick("name"), uom: pick("uom"), category: pick("category"), units };
}

async function editDraft(db: D1Database, actorId: number, d: DraftRow, p: DraftPayloads["edit"], via: Via) {
  const now = await get<{ name: string; uom: string; category: string }>(db, "SELECT name, uom, category FROM catalog_items WHERE id = ?", d.item_id);
  if (!now) return fail("Item tidak ditemukan.", 404);
  const units = (await unitsByCode(db, [d.code])).get(d.code) ?? [];
  return editItem(db, actorId, d.item_id, editOverCurrent({ ...now, units }, JSON.parse(d.before), p), true, via);
}

/** ACC of a stock draft: the catalog stock is set, the history row names who filled and who ACCed, and the item waits to be sent. */
async function applyStockDraft(db: D1Database, actorId: number, d: DraftRow): Promise<Fail | null> {
  const now = await get<{ stock: number; uom: string }>(db, "SELECT stock, uom FROM catalog_items WHERE id = ?", d.item_id);
  if (!now) return fail("Item tidak ditemukan.", 404);
  const next = (JSON.parse(d.payload) as DraftPayloads["stock"]).stock;
  await batch(db, [
    stmt(db, "UPDATE catalog_items SET stock = ?, updated_at = datetime('now') WHERE id = ?", next, d.item_id),
    stmt(
      db,
      `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, draft_id, filled_by, approved_by) VALUES(?, ?, ?, ?, 'draft_approved', ?, ?, ?)`,
      d.code, now.uom, now.stock, next, d.id, d.created_by, actorId,
    ),
    ...(now.stock !== next ? [stmt(db, "INSERT INTO stock_unsent(code) VALUES(?) ON CONFLICT(code) DO NOTHING", d.code)] : []),
  ]);
  await audit(db, actorId, "catalog", d.item_id, "stock_set", { code: d.code, before: now.stock, after: next, draft_id: d.id, proposed_by: d.created_by });
  return null;
}

/** Applies an ACCed draft as the admin, through the same checks as a direct save. */
async function applyDraft(env: Env["Bindings"], actorId: number, d: DraftRow): Promise<Fail | null> {
  const db = env.DB;
  if (d.kind === "stock") return applyStockDraft(db, actorId, d);
  if (d.kind === "import") {
    await applyImportDrafts(env, actorId, [{ ...d, import_id: d.import_id ?? null }]);
    return null;
  }
  const via: Via = { draft_id: d.id, proposed_by: d.created_by };
  const p = JSON.parse(d.payload);
  const r =
    d.kind === "barcode"
      ? p.generate
        ? await generateBarcode(db, actorId, d.item_id, d.uom, true, via)
        : await setBarcode(db, actorId, d.item_id, d.uom, p.barcode ?? null, true, via)
      : d.kind === "unit"
        ? await addUnit(db, actorId, d.item_id, { uom: d.uom, factor: p.factor, barcode: p.barcode, generate: p.generate }, true, true, via)
        : await editDraft(db, actorId, d, p, via);
  return failed(r) ? r : null;
}

/**
 * ACC (the change is applied now, as the admin) or Tolak (a reason is required). A draft that no longer
 * fits (e.g. its barcode went to another item meanwhile) is not ACCed: the error says why, and it waits.
 */
catalogRouter.post("/drafts/:draftId/review", requirePermission("review_catalog_drafts"), async (c) => {
  const user = c.get("user")!;
  const draftId = Number(c.req.param("draftId"));
  const parsed = z
    .object({ approve: z.boolean(), note: z.string().trim().max(500).default("") })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { approve, note } = parsed.data;
  if (!approve && !note) return c.json({ error: "Tulis alasan penolakan supaya gudang tahu apa yang perlu diperbaiki." }, 400);
  const d = await get<DraftRow>(c.env.DB, "SELECT id, item_id, code, kind, uom, payload, before, created_by, import_id FROM catalog_drafts WHERE id = ?", draftId);
  if (!d) return c.json({ error: "Draf tidak ditemukan." }, 404);
  // Claim it first, so a second admin pressing ACC at the same time cannot apply it twice.
  const claim = await run(
    c.env.DB,
    `UPDATE catalog_drafts SET status = ?, note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    approve ? "approved" : "rejected", note, user.id, draftId,
  );
  if (!claim.meta.changes) return c.json({ error: "Draf ini sudah diproses." }, 409);
  if (approve) {
    const f = await applyDraft(c.env, user.id, d);
    if (f) {
      await run(c.env.DB, "UPDATE catalog_drafts SET status = 'pending', note = '', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?", draftId);
      return c.json({ error: f.error }, f.status);
    }
  }
  if (!approve && d.kind === "stock") {
    // The stock stays; the history keeps who proposed what and why it was refused.
    const cur = await get<{ stock: number; uom: string }>(c.env.DB, "SELECT stock, uom FROM catalog_items WHERE id = ?", d.item_id);
    await run(
      c.env.DB,
      `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, draft_id, filled_by, approved_by, note) VALUES(?, ?, ?, ?, 'draft_rejected', ?, ?, ?, ?)`,
      d.code, cur?.uom ?? "", cur?.stock ?? 0, (JSON.parse(d.payload) as DraftPayloads["stock"]).stock, d.id, d.created_by, user.id, note,
    );
  }
  // An ACCed import draft was audited with its writes (applyImportDrafts).
  if (!(approve && d.kind === "import")) {
    await audit(c.env.DB, user.id, "catalog", d.item_id, approve ? "catalog_draft_approved" : "catalog_draft_rejected", { code: d.code, kind: d.kind, uom: d.uom, draft_id: draftId, note });
  }
  return c.json({ ok: true });
});

/** Without view_costs a viewer sees no COGS or price, in a draft or in the item it would change. */
const hideCosts = (role: Role, o: Record<string, unknown>) => {
  if (hasPermission(role, "view_costs")) return o;
  const { cogs: _c, list_price: _p, ...rest } = o;
  return rest;
};

/** Import files (Gudang groups their drafts per file): waiting ones, or the finished ones (newest first, last 50). */
catalogRouter.get("/imports", async (c) => {
  const user = c.get("user")!;
  const viewer = draftViewer(user.role);
  if (!viewer) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  const done = c.req.query("status") === "done";
  const imports = await all(
    c.env.DB,
    `SELECT i.id, i.source, i.mode, i.rows, i.created_at, u.name AS created_by_name, COUNT(d.id) AS total,
            SUM(d.status = 'pending') AS pending, SUM(d.status = 'approved') AS approved, SUM(d.status = 'rejected') AS rejected
       FROM catalog_imports i
       JOIN catalog_drafts d ON d.import_id = i.id
       LEFT JOIN users u ON u.id = i.created_by
      ${viewer === "own" ? "WHERE i.created_by = ?" : ""}
      GROUP BY i.id
     HAVING SUM(d.status = 'pending') ${done ? "= 0" : "> 0"}
      ORDER BY ${done ? "i.id DESC LIMIT 50" : "i.id"}`,
    ...(viewer === "own" ? [user.id] : []),
  );
  return c.json({ imports });
});

/** The waiting drafts of one import file, a page at a time (a file can hold 20.000 items). */
catalogRouter.get("/imports/:importId/drafts", async (c) => {
  const user = c.get("user")!;
  const viewer = draftViewer(user.role);
  if (!viewer) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  const importId = Number(c.req.param("importId"));
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const own = viewer === "own" ? "AND created_by = ?" : "";
  const args = viewer === "own" ? [user.id] : [];
  const rows = await all<{ id: number; code: string; payload: string; before: string; created_at: string }>(
    c.env.DB,
    `SELECT id, code, payload, before, created_at FROM catalog_drafts
      WHERE import_id = ? AND status = 'pending' ${own} ORDER BY id LIMIT ? OFFSET ?`,
    importId, ...args, limit, offset,
  );
  const total = (await get<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM catalog_drafts WHERE import_id = ? AND status = 'pending' ${own}`, importId, ...args))?.n ?? 0;
  // A new item may already be in the catalog under another code (pemilik, 2026-11-20): name the closest
  // matches so the admin can refuse it. Only items whose every word matched, at most three.
  const [index, priority] = await Promise.all([catalogIndex(c.env.DB), searchPriority(c.env.DB)]);
  const similarTo = (code: string, payload: Record<string, unknown>, before: Record<string, unknown>) => {
    if (Object.keys(before).length || typeof payload.name !== "string" || !payload.name.trim()) return [];
    const found = searchCatalog(index, payload.name, { priority });
    if (found.partial) return [];
    return found.items.filter((i) => i.code.toLowerCase() !== code.toLowerCase()).slice(0, 3).map((i) => ({ code: i.code, name: i.name }));
  };
  return c.json({
    total,
    drafts: rows.map((r) => ({
      id: r.id, code: r.code, kind: "import", uom: "", status: "pending",
      payload: hideCosts(user.role, JSON.parse(r.payload)), before: hideCosts(user.role, JSON.parse(r.before)),
      similar: similarTo(r.code, JSON.parse(r.payload), JSON.parse(r.before)),
    })),
  });
});

const importReviewInput = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).default(""),
  /** Only these drafts of the file; left out = every waiting draft of the file. */
  ids: z.array(z.number().int()).max(20000).optional(),
});

/**
 * ACC or Tolak a whole import file, or the chosen drafts of it, in one call (batched, not one request per
 * item). The drafts are claimed first, so two admins pressing ACC at once cannot apply a row twice.
 */
catalogRouter.post("/imports/:importId/review", requirePermission("review_catalog_drafts"), async (c) => {
  const user = c.get("user")!;
  const importId = Number(c.req.param("importId"));
  const parsed = importReviewInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { approve, note, ids } = parsed.data;
  if (!approve && !note) return c.json({ error: "Tulis alasan penolakan supaya yang mengunggah tahu apa yang perlu diperbaiki." }, 400);
  if (!(await get(c.env.DB, "SELECT id FROM catalog_imports WHERE id = ?", importId))) return c.json({ error: "Impor tidak ditemukan." }, 404);
  const claimSql = `UPDATE catalog_drafts SET status = ?, note = ?, reviewed_by = ?, reviewed_at = datetime('now')
     WHERE import_id = ? AND status = 'pending' ${ids ? "AND id IN (SELECT value FROM json_each(?))" : ""}
     RETURNING id, item_id, code, payload, created_by, import_id`;
  const claimed: ImportDraftRow[] = [];
  for (const part of ids ? chunks(ids, 2000) : [null]) {
    claimed.push(...(await all<ImportDraftRow>(c.env.DB, claimSql, approve ? "approved" : "rejected", note, user.id, importId, ...(part ? [JSON.stringify(part)] : []))));
  }
  if (!claimed.length) return c.json({ error: "Tidak ada draf yang menunggu di impor ini." }, 409);
  let cogsFromPurchases = 0;
  if (approve) {
    try {
      cogsFromPurchases = (await applyImportDrafts(c.env, user.id, claimed)).cogsFromPurchases;
    } catch (e) {
      // Applying is an upsert, so ACC again later finishes what stopped here.
      for (const part of chunks(claimed.map((d) => d.id), 2000)) {
        await run(c.env.DB, "UPDATE catalog_drafts SET status = 'pending', note = '', reviewed_by = NULL, reviewed_at = NULL WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(part));
      }
      return c.json({ error: `ACC gagal di tengah jalan (${e instanceof Error ? e.message : "kesalahan"}). Coba lagi.` }, 500);
    }
  }
  await audit(c.env.DB, user.id, "catalog", 0, approve ? "import_approved" : "import_rejected", { import_id: importId, count: claimed.length, whole_file: !ids, note, cogsFromPurchases });
  return c.json({ ok: true, count: claimed.length, cogsFromPurchases });
});

/** The Admin Gudang takes back their own waiting draft. */
catalogRouter.post("/drafts/:draftId/cancel", async (c) => {
  const user = c.get("user")!;
  const draftId = Number(c.req.param("draftId"));
  const d = await get<{ item_id: number; code: string }>(
    c.env.DB, "SELECT item_id, code FROM catalog_drafts WHERE id = ? AND created_by = ? AND status = 'pending'", draftId, user.id,
  );
  if (!d) return c.json({ error: "Draf tidak ditemukan atau sudah diproses." }, 404);
  await run(c.env.DB, "UPDATE catalog_drafts SET status = 'cancelled', reviewed_at = datetime('now') WHERE id = ?", draftId);
  await audit(c.env.DB, user.id, "catalog", d.item_id, "catalog_draft_cancelled", { code: d.code, draft_id: draftId });
  return c.json({ ok: true });
});

/** Every unit proposal waiting for a manager, oldest first (Katalog › Usulan satuan). */
catalogRouter.get("/unit-proposals", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT i.id, p.code, i.name, i.uom AS base_uom, p.uom, p.factor, u.name AS proposed_by, p.created_at, b.barcode
       FROM catalog_unit_proposals p
       JOIN catalog_items i ON i.code = p.code
       LEFT JOIN users u ON u.id = p.proposed_by
       LEFT JOIN catalog_unit_barcodes b ON b.code = p.code AND b.uom = p.uom
      ORDER BY p.created_at, p.code`,
  );
  return c.json({ proposals: rows });
});

/** A manager approves a proposed unit (quotes use it from now on) or rejects it (its barcode goes too). */
catalogRouter.post("/:id/unit/review", requirePermission("edit_catalog"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = z.object({ uom: z.string().trim().min(1).max(32), approve: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const item = await itemSkus(c.env.DB, id);
  if (!item) return c.json({ error: "Item tidak ditemukan." }, 404);
  const p = item.proposals.find((u) => sameUom(u.uom, parsed.data.uom));
  if (!p) return c.json({ error: `Tidak ada usulan satuan ${parsed.data.uom} untuk barang ini.` }, 404);
  const taken = item.units.some((u) => sameUom(u.uom, p.uom));
  await batch(c.env.DB, [
    stmt(c.env.DB, "DELETE FROM catalog_unit_proposals WHERE code = ? AND uom = ?", item.code, p.uom),
    ...(parsed.data.approve
      ? // Accurate may have brought the same unit meanwhile: its ratio stays, the proposal just closes.
        taken ? [] : [stmt(c.env.DB, "INSERT INTO catalog_item_uoms(code, uom, factor, manual) VALUES(?, ?, ?, 1)", item.code, p.uom, p.factor)]
      : taken ? [] : [stmt(c.env.DB, "DELETE FROM catalog_unit_barcodes WHERE code = ? AND uom = ?", item.code, p.uom)]),
  ]);
  await audit(c.env.DB, user.id, "catalog", id, parsed.data.approve ? "unit_approved" : "unit_rejected", { code: item.code, uom: p.uom, factor: p.factor });
  return c.json(await skuOut(c.env.DB, item.code));
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

catalogRouter.post("/uom", async (c) => {
  const user = c.get("user")!;
  // Only a name for the unit list; an Admin Gudang needs it in Ubah barang, where the rest is a draft.
  if (!hasPermission(user.role, "edit_catalog") && !drafting(user.role)) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
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
  const stats = await get<{ total: number; priced: number; withList: number; withImage: number; updated: string | null }>(
    c.env.DB,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN cogs > 0 THEN 1 ELSE 0 END) AS priced,
            SUM(CASE WHEN list_price > 0 THEN 1 ELSE 0 END) AS withList,
            SUM(CASE WHEN code IN (SELECT code FROM item_images) THEN 1 ELSE 0 END) AS withImage,
            MAX(updated_at) AS updated
       FROM catalog_items`,
  );
  return c.json({ stats });
});

/**
 * Impor katalog (pemilik, 2026-11-20): an upload no longer touches the catalog. Every file row that would
 * change something becomes an `import` draft (payload = the file row + mode, before = the item now) and
 * waits for an admin's ACC in Gudang; in replace mode an item the file leaves out becomes a delete draft.
 * Applying a draft is applyImportDrafts below, with the same rules the import always had.
 * The client does the XLSX parsing and posts plain rows, so the server never handles uploaded binaries.
 * D1 has no interactive transactions, so current items are read once up front and drafts are written
 * in batches (one statement per row, never one query per row).
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

  // A code twice in one file: the last row wins (one waiting draft per code).
  const byCode = new Map<string, z.infer<typeof catalogRowSchema>>();
  for (const r of rows) if (r.code.trim()) byCode.set(r.code.trim(), { ...r, code: r.code.trim() });
  const codes = [...byCode.keys()];
  if (replace && !codes.length) return c.json({ error: "File tidak berisi kode barang." }, 400);

  const current = new Map<string, ImportItem & { id: number }>();
  for (const chunk of chunks(codes, CHUNK)) {
    const found = await all<Omit<ImportItem, "units"> & { id: number; code: string }>(
      c.env.DB,
      `SELECT id, code, name, uom, cogs, list_price, stock, category FROM catalog_items WHERE code IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
    );
    for (const f of found) current.set(f.code, { ...f, units: [] });
  }
  const withUnits = [...current.keys()].filter((code) => byCode.get(code)?.units);
  for (const [code, units] of await unitsByCode(c.env.DB, withUnits)) current.get(code)!.units = units;
  const purchased = await purchasedCodes(c.env, [...current.keys()]);

  type NewDraft = { item_id: number; code: string; payload: unknown; before: unknown };
  const news: NewDraft[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const r of byCode.values()) {
    const cur = current.get(r.code) ?? null;
    if (cur && importUnchanged(importNext(mode, r, cur, purchased.has(r.code)), cur)) {
      unchanged++;
      continue;
    }
    cur ? updated++ : inserted++;
    const { id, ...before } = cur ?? { id: 0 };
    news.push({ item_id: id, code: r.code, payload: { ...r, mode }, before });
  }
  // Items the file leaves out go in the same import, so ACC of the whole file is the whole replacement.
  let removed = 0;
  if (replace) {
    const keep = new Set(codes);
    const gone = await all<{ id: number; code: string; name: string; uom: string; cogs: number; list_price: number; stock: number; category: string }>(
      c.env.DB, "SELECT id, code, name, uom, cogs, list_price, stock, category FROM catalog_items",
    );
    const goneUnits = await unitsByCode(c.env.DB, gone.filter((g) => !keep.has(g.code)).map((g) => g.code));
    for (const { id, ...g } of gone) {
      if (keep.has(g.code)) continue;
      removed++;
      news.push({ item_id: id, code: g.code, payload: { delete: true }, before: { ...g, units: goneUnits.get(g.code) ?? [] } });
    }
  }

  const result = { inserted, updated, unchanged, drafts: news.length, ...(replace && { removed }) };
  let importId: number | null = null;
  if (news.length) {
    const info = await run(c.env.DB, "INSERT INTO catalog_imports(source, mode, rows, created_by) VALUES(?, ?, ?, ?)", source, mode, rows.length, user.id);
    importId = Number(info.meta.last_row_id);
    for (const chunk of chunks(news, CHUNK)) {
      await batch(c.env.DB, chunk.map((d) =>
        // A second file for the same code takes over its waiting draft.
        stmt(
          c.env.DB,
          `INSERT INTO catalog_drafts(item_id, code, kind, uom, payload, before, created_by, import_id) VALUES(?, ?, 'import', '', ?, ?, ?, ?)
           ON CONFLICT(code, kind, uom) WHERE status = 'pending'
           DO UPDATE SET item_id = excluded.item_id, payload = excluded.payload, before = excluded.before, created_by = excluded.created_by,
                         import_id = excluded.import_id, created_at = datetime('now')`,
          d.item_id, d.code, JSON.stringify(d.payload), JSON.stringify(d.before), user.id, importId,
        ),
      ));
    }
  }
  await audit(c.env.DB, user.id, "catalog", 0, "imported", { ...result, importId, source, mode, rows: rows.length });
  return c.json({ importId, ...result, total: rows.length });
});

/** Items that already have a priced Accurate goods receipt: their COGS comes from "Terapkan COGS", not from a file. */
async function purchasedCodes(env: Env["Bindings"], existing: string[]): Promise<Set<string>> {
  // COGS = harga pembelian terakhir (Ryoma, 2026-10-15): a spreadsheet (the Nilai Persediaan average)
  // must not overwrite it. Other fields still update.
  const purchased = new Set<string>();
  const entity = catalogEntity(env);
  for (const chunk of chunks(existing, CHUNK - 1)) {
    const found = await all<{ item_code: string }>(
      env.DB,
      `SELECT DISTINCT item_code FROM ${costLines(env)}
        WHERE entity = ? AND unit_price > 0 AND quantity > 0 AND item_code IN (${chunk.map(() => "?").join(",")})`,
      entity,
      ...chunk,
    );
    for (const f of found) purchased.add(f.item_code);
  }
  return purchased;
}

// ?9 is NULL for a purchased item (its COGS stays); ?10 = 1 in replace mode, where the file wins and a 0
// or blank is written as such. A blank unit keeps the current one in both modes, so the item's unit
// ratios stay valid. Stock is not written here: it follows, with its history (see applyImportDrafts).
// Keep in step with importNext (shared/catalogImport.ts).
const UPSERT_ITEM_SQL = `
  INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category, source)
  VALUES (
    ?1, ?2, COALESCE(NULLIF(?3, ''), 'Pcs'), ?4, ?5, 0, ?7, ?8
  )
  ON CONFLICT(code) DO UPDATE SET
    name = ?2,
    uom = CASE WHEN ?3 != '' THEN ?3 ELSE catalog_items.uom END,
    cogs = CASE WHEN ?9 IS NULL THEN catalog_items.cogs WHEN ?9 > 0 OR ?10 = 1 THEN ?9 ELSE catalog_items.cogs END,
    list_price = CASE WHEN ?5 > 0 OR ?10 = 1 THEN ?5 ELSE catalog_items.list_price END,
    category = CASE WHEN ?7 != '' OR ?10 = 1 THEN ?7 ELSE catalog_items.category END,
    source = ?8,
    updated_at = datetime('now')`;

type ImportDraftRow = Pick<DraftRow, "id" | "item_id" | "code" | "payload" | "created_by"> & { import_id: number | null };

/**
 * Applies ACCed `import` drafts (already claimed by the caller) as the admin: the same writes the old
 * direct import made, in batches. Stock from the file goes through stock_history (source 'import') and
 * stock_unsent like an ACCed stock draft. One audit row per draft, with the draft id.
 */
async function applyImportDrafts(env: Env["Bindings"], actorId: number, drafts: ImportDraftRow[]): Promise<{ applied: number; cogsFromPurchases: number }> {
  const db = env.DB;
  const items = drafts.map((d) => ({ d, p: JSON.parse(d.payload) as Record<string, unknown> }));
  const writeCodes = items.filter((x) => !x.p.delete).map((x) => x.d.code);
  const baseUom = new Map<string, string>();
  for (const chunk of chunks(writeCodes, CHUNK)) {
    for (const f of await all<{ code: string; uom: string }>(db, `SELECT code, uom FROM catalog_items WHERE code IN (${chunk.map(() => "?").join(",")})`, ...chunk)) {
      baseUom.set(f.code, f.uom);
    }
  }
  const purchased = await purchasedCodes(env, [...baseUom.keys()]);
  const sources = new Map<number, string>();
  for (const id of new Set(drafts.map((d) => d.import_id).filter((i): i is number => i != null))) {
    sources.set(id, (await get<{ source: string }>(db, "SELECT source FROM catalog_imports WHERE id = ?", id))?.source ?? "import");
  }

  let cogsFromPurchases = 0;
  const auditStmt = (d: ImportDraftRow, extra: Record<string, unknown> = {}) =>
    stmt(
      db,
      `INSERT INTO audit_log(actor_id, entity, entity_id, action, detail)
       VALUES(?1, 'catalog', COALESCE((SELECT id FROM catalog_items WHERE code = ?2), ?3), 'catalog_draft_approved', ?4)`,
      actorId, d.code, d.item_id,
      JSON.stringify({ code: d.code, kind: "import", uom: "", draft_id: d.id, import_id: d.import_id, proposed_by: d.created_by, ...extra }),
    );
  for (const chunk of chunks(items, 60)) {
    const statements = chunk.flatMap(({ d, p }) => {
      if (p.delete) {
        return [
          stmt(db, "DELETE FROM catalog_item_uoms WHERE code = ?", d.code),
          auditStmt(d, { deleted: true }),
          stmt(db, "DELETE FROM catalog_items WHERE code = ?", d.code),
        ];
      }
      const r = p as unknown as ImportRow & { mode?: ImportMode };
      const keepCogs = purchased.has(d.code);
      if (keepCogs && (r.cogs ?? 0) > 0) cogsFromPurchases++;
      return [
        stmt(db, UPSERT_ITEM_SQL, d.code, r.name, r.uom ?? "", r.cogs ?? 0, r.list_price ?? 0, null, r.category ?? "",
          sources.get(d.import_id ?? 0) ?? "import", keepCogs ? null : (r.cogs ?? 0), r.mode === "replace" ? 1 : 0),
        ...(r.units ? replaceUnitsStmts(db, d.code, r.uom || baseUom.get(d.code) || "Pcs", r.units) : []),
        ...(r.stock != null
          ? [
              stmt(
                db,
                `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, draft_id, filled_by, approved_by)
                 SELECT code, uom, stock, ?2, 'import', ?3, ?4, ?5 FROM catalog_items WHERE code = ?1 AND stock IS NOT ?2`,
                d.code, r.stock, d.id, d.created_by, actorId,
              ),
              stmt(db, "INSERT INTO stock_unsent(code) SELECT code FROM catalog_items WHERE code = ?1 AND stock IS NOT ?2 ON CONFLICT(code) DO NOTHING", d.code, r.stock),
              stmt(db, "UPDATE catalog_items SET stock = ?2, updated_at = datetime('now') WHERE code = ?1", d.code, r.stock),
            ]
          : []),
        auditStmt(d),
      ];
    });
    await batch(db, statements);
  }
  // Replace pauses Accurate's new items until "Terapkan" is answered OK, as the direct replace did.
  if (items.some((x) => x.p.mode === "replace" || x.p.delete)) await run(db, PAUSE_NEW_ITEMS_SQL, actorId);
  // Barang baru requests whose code this import brought into the catalog are linked, and their tasks closed.
  await sweepPending(db);
  return { applied: drafts.length, cogsFromPurchases };
}

const editInput = z.object({
  name: z.string().min(1).max(300),
  uom: z.string().max(32),
  // Left out by an Admin Gudang, who never sees costs or prices: the item keeps its own.
  cogs: z.number().min(0).optional(),
  list_price: z.number().min(0).optional(),
  category: z.string().max(120).default(""),
  units: unitsSchema.optional(),
});
type EditOld = { code: string; name: string; uom: string; cogs: number; list_price: number; category: string };

async function editItem(
  db: D1Database, actorId: number, id: number, d: z.infer<typeof editInput>, apply: boolean, via?: Via,
): Promise<Fail | { old: EditOld; units: UnitFactor[] }> {
  const old = await get<EditOld>(db, "SELECT code, name, uom, cogs, list_price, category FROM catalog_items WHERE id = ?", id);
  if (!old) return fail("Item tidak ditemukan.", 404);
  const oldUnits = (await unitsByCode(db, [old.code])).get(old.code) ?? [];
  if (!apply) return { old, units: oldUnits };
  const next = { ...d, cogs: d.cogs ?? old.cogs, list_price: d.list_price ?? old.list_price };
  await batch(db, [
    stmt(
      db,
      `UPDATE catalog_items SET name = ?, uom = ?, cogs = ?, list_price = ?, category = ?,
              updated_at = datetime('now') WHERE id = ?`,
      next.name, next.uom, next.cogs, next.list_price, next.category, id,
    ),
    ...(d.units ? replaceUnitsStmts(db, old.code, next.uom, d.units) : []),
  ]);
  // Old → new of each field that changed, so "who moved this COGS from X to Y" has an answer.
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of ["name", "uom", "cogs", "list_price", "category"] as const) {
    if (old[k] !== next[k]) [before[k], after[k]] = [old[k], next[k]];
  }
  await audit(db, actorId, "catalog", id, "updated", { code: old.code, before, after, ...(d.units && { units: d.units }), ...via });
  return { old, units: oldUnits };
}

/** Ubah barang. An Admin Gudang's edit (name, units, category; never cost or price) is a draft for an admin. */
catalogRouter.put("/:id", async (c) => {
  const user = c.get("user")!;
  const draft = drafting(user.role);
  if (!draft && !hasPermission(user.role, "edit_catalog")) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  const id = Number(c.req.param("id"));
  const parsed = editInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const d = draft ? { ...parsed.data, cogs: undefined, list_price: undefined } : parsed.data;
  const r = await editItem(c.env.DB, user.id, id, d, !draft);
  if (failed(r)) return c.json({ error: r.error }, r.status);
  if (draft) {
    const { name, uom, category, units } = d;
    const payload = { name, uom, category, ...(units && { units: cleanUnits(uom, units) }) };
    const before = { name: r.old.name, uom: r.old.uom, category: r.old.category, units: r.units };
    if (draftChanges("edit", "", payload, before)[0] === NO_CHANGE) return c.json({ error: "Belum ada yang diubah." }, 400);
    const f = await saveDraft(c.env.DB, user.id, { item_id: id, code: r.old.code, kind: "edit", uom: "", payload, before });
    if (f) return c.json({ error: f.error }, f.status);
  }
  const item = await get<CatalogItem>(c.env.DB, "SELECT * FROM catalog_items WHERE id = ?", id);
  const units = item ? (await unitsByCode(c.env.DB, [item.code])).get(item.code) ?? [] : [];
  return c.json({ item: item && catalogItemsForViewer(user.role, [{ ...item, units }])[0], draft });
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
