/* Stok di Pricing Engine (pemilik, 2026-11-20): Tarik (Accurate -> Pricing Engine), Cocokkan (bandingkan),
   status Kirim, dan riwayat stok. Kirim belum menulis ke Accurate sama sekali (klien Accurate hanya-baca).
   Draf stok dan ACC-nya ada di routes/catalog.ts. Tidak ada COGS atau harga di sini: role gudang tidak
   punya view_costs. */

import { Hono } from "hono";
import { z } from "zod";
import { all, get, run } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { canUseStockBook, hasPermission } from "../../../shared/permissions";
import { zodMessage } from "../../validate";
import { ACCURATE_TOTALS, IS_UNSENT, SAME_UNIT, matchEnteredCounts, pullStock } from "../accurate/stock";
import { catalogEntity, credsFor, loadState, requestRestart, syncConfig, syncStep } from "../accurate/sync";
import { buildTimeline, type TimelineCount, type TimelineMutation } from "../../../shared/stockTimeline";
import { countWarehouses } from "./catalog";
import type { Env } from "../env";

export const stockRouter = new Hono<Env>();
stockRouter.use(requireAuth);
// Manager/admin (import_catalog) and Admin Gudang (draft_catalog); a rep has no stock tools.
stockRouter.use(async (c, next) => {
  const role = c.get("user")!.role;
  if (!hasPermission(role, "import_catalog") && !hasPermission(role, "draft_catalog")) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  await next();
});

const unsentCount = async (db: D1Database) => (await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM stock_unsent"))?.n ?? 0;

/** Kirim: the switch (default off) and how many ACCed changes wait to be sent. */
stockRouter.get("/status", async (c) => {
  const flag = await get<{ value: string }>(c.env.DB, "SELECT value FROM settings WHERE key = 'stock_push_enabled'");
  const open = await get<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM stock_counts WHERE status = 'open'");
  return c.json({ pushEnabled: flag?.value === "1", unsent: await unsentCount(c.env.DB), open: open?.n ?? 0 });
});

/**
 * Tarik. The same sync as /api/accurate/sync (it can take several calls: the client repeats until `done`),
 * then, once a run has completed, the stock copy. `restart` on the first call starts a fresh run.
 */
stockRouter.post("/pull", async (c) => {
  const parsed = z.object({ restart: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const entity = catalogEntity(c.env);
  const creds = credsFor(c.env, entity);
  if (!creds) return c.json({ error: `Token Accurate untuk ${entity} belum dipasang di server.` }, 400);
  if (parsed.data.restart) await requestRestart(c.env.DB, entity);
  const cfg = syncConfig(c.env);
  const step = await syncStep(c.env.DB, entity, creds, cfg, { deadline: Date.now() + 20_000 });
  if (step.outcome === "error") return c.json({ error: step.error ?? "Sinkron Accurate gagal." }, 502);
  const st = await loadState(c.env.DB, entity);
  if ((step.outcome !== "idle" && step.outcome !== "finished") || st.phase !== "idle" || !st.last_success_at) {
    return c.json({ done: false, phase: st.phase, itemsSeen: st.items_seen, stockRows: st.stock_rows, busy: step.outcome === "locked" });
  }
  const user = c.get("user")!;
  const r = await pullStock(c.env.DB, entity, user.id);
  const entered = await matchEnteredCounts(c.env.DB, entity);
  await audit(c.env.DB, user.id, "stock", 0, "stock_pulled", { entity, ...r });
  return c.json({ done: true, ...r, entered, asOf: st.last_success_at });
});

/** Cocokkan: items whose Pricing Engine stock differs from Accurate's total over all warehouses (same unit rule). */
stockRouter.get("/compare", async (c) => {
  const entity = catalogEntity(c.env);
  const rows = await all<{ code: string; name: string; uom: string; pe: number; accurate: number; unsent: number }>(
    c.env.DB,
    `SELECT c.code, c.name, c.uom, c.stock AS pe, s.qty AS accurate, ${IS_UNSENT} AS unsent
       FROM (${ACCURATE_TOTALS}) s JOIN catalog_items c ON ${SAME_UNIT}
      WHERE c.stock IS NOT s.qty
      ORDER BY unsent DESC, abs(c.stock - s.qty) DESC, c.code LIMIT 501`,
    entity,
  );
  const items = rows.slice(0, 500).map((r) => ({ ...r, unsent: !!r.unsent, diff: r.pe - r.accurate }));
  return c.json({ entity, items, more: rows.length > 500, asOf: (await loadState(c.env.DB, entity)).last_success_at });
});

/** Riwayat stok: one item (`code`) or the latest across all items (of those, one big import file shows only its last 30 rows). */
stockRouter.get("/history", async (c) => {
  const code = c.req.query("code")?.trim() ?? "";
  const rows = await all(
    c.env.DB,
    `SELECT h.id, h.code, i.name, h.uom, h.qty_before AS before, h.qty_after AS after, h.source, h.draft_id, h.note, h.created_at,
            f.name AS filled_by_name, a.name AS approved_by_name
       FROM stock_history h
       LEFT JOIN catalog_items i ON i.code = h.code
       LEFT JOIN users f ON f.id = h.filled_by
       LEFT JOIN users a ON a.id = h.approved_by
      ${code ? "WHERE h.code = ? COLLATE NOCASE" : "WHERE (h.source != 'import' OR h.id IN (SELECT id FROM stock_history WHERE source = 'import' ORDER BY id DESC LIMIT 30))"}
      ORDER BY h.id DESC LIMIT ${code ? 100 : 200}`,
    ...(code ? [code] : []),
  );
  return c.json({ history: rows });
});

/** Gudang Accurate untuk isian cycle count (bawaan dulu); dengan ?code= juga gudang yang wajib diisi untuk barang itu. */
stockRouter.get("/warehouses", async (c) => {
  const code = c.req.query("code")?.trim() ?? "";
  const w = await countWarehouses(c.env.DB, catalogEntity(c.env), code);
  return c.json({ warehouses: w.all, required: code ? w.required : [] });
});

/**
 * Stok pembanding (cycle count yang di-ACC). `status=open`: belum masuk Accurate (admin). `code`: riwayat hitung
 * satu barang (semua yang punya akses stok). `diff` = yang perlu diinput sebagai penyesuaian di Accurate.
 */
stockRouter.get("/counts", async (c) => {
  const code = c.req.query("code")?.trim() ?? "";
  const open = c.req.query("status") === "open";
  const role = c.get("user")!.role;
  if (!canUseStockBook(role)) return c.json({ error: "Stok pembanding hanya untuk Admin dan Admin Gudang." }, 403);
  if (!code && !hasPermission(role, "review_catalog_drafts")) return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  const rows = await all<{ counted: number; accurate_qty: number | null }>(
    c.env.DB,
    `SELECT s.id, s.code, i.name, s.uom, s.warehouse, s.owner, s.counted, s.accurate_qty, s.accurate_source, s.counted_at, s.approved_at,
            s.status, s.entered_at, s.entered_how, s.entered_ref, s.note,
            f.name AS counted_by_name, a.name AS approved_by_name, e.name AS entered_by_name
       FROM stock_counts s
       LEFT JOIN catalog_items i ON i.code = s.code
       LEFT JOIN users f ON f.id = s.counted_by
       LEFT JOIN users a ON a.id = s.approved_by
       LEFT JOIN users e ON e.id = s.entered_by
      WHERE ${code ? "s.code = ? COLLATE NOCASE" : open ? "s.status = 'open'" : "1 = 1"}
      ORDER BY ${open ? "s.approved_at ASC, s.id ASC" : "s.counted_at DESC, s.id DESC"} LIMIT 500`,
    ...(code ? [code] : []),
  );
  return c.json({ counts: rows.map((r) => ({ ...r, diff: r.accurate_qty == null ? null : r.counted - r.accurate_qty })) });
});

/** "Sudah masuk Accurate": hitungan keluar dari daftar; siapa yang menandai dan catatannya tersimpan. */
stockRouter.post("/counts/done", requirePermission("review_catalog_drafts"), async (c) => {
  const parsed = z
    .object({ ids: z.array(z.number().int().positive()).min(1, "Pilih hitungannya dulu.").max(500), note: z.string().trim().max(300).default("") })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const user = c.get("user")!;
  const ids = [...new Set(parsed.data.ids)];
  const r = await run(
    c.env.DB,
    `UPDATE stock_counts SET status = 'entered', entered_at = datetime('now'), entered_by = ?, entered_how = 'manual', entered_ref = ?
      WHERE status = 'open' AND id IN (${ids.map(() => "?").join(", ")})`,
    user.id, parsed.data.note, ...ids,
  );
  await audit(c.env.DB, user.id, "stock", 0, "stock_marked_entered", { ids, done: r.meta.changes, note: parsed.data.note });
  return c.json({ done: r.meta.changes });
});

/**
 * Stok minus per gudang (salinan sinkron Accurate terakhir). Total semua gudang bisa menutupi minus di satu gudang,
 * jadi dilihat per gudang. Tanpa harga atau COGS.
 */
stockRouter.get("/minus", async (c) => {
  const entity = catalogEntity(c.env);
  const rows = await all(
    c.env.DB,
    `SELECT q.item_code AS code, COALESCE(i.name, a.name) AS name, COALESCE(NULLIF(a.uom, ''), i.uom) AS uom, w.name AS warehouse,
            q.quantity AS qty, q.synced_at
       FROM accurate_stock q
       JOIN accurate_warehouses w ON w.entity = q.entity AND w.accurate_id = q.warehouse_id
       LEFT JOIN accurate_items a ON a.entity = q.entity AND a.code = q.item_code
       LEFT JOIN catalog_items i ON i.code = q.item_code COLLATE NOCASE
      WHERE q.entity = ? AND q.quantity < 0
      ORDER BY q.quantity ASC, q.item_code LIMIT 500`,
    entity,
  );
  return c.json({ items: rows });
});

/**
 * Riwayat stok satu barang per gudang: stok Accurate terakhir, riwayat mutasi tersimpan (saldo dihitung mundur),
 * dan hasil cycle count sebagai titik pembanding. Tanpa harga atau COGS (item_cost mutasi tidak dikirim).
 */
stockRouter.get("/item", async (c) => {
  const code = c.req.query("code")?.trim() ?? "";
  if (!code) return c.json({ error: "Kode barang wajib diisi." }, 400);
  const entity = catalogEntity(c.env);
  const item = await get<{ code: string; name: string; uom: string; stock: number }>(
    c.env.DB, "SELECT code, name, uom, stock FROM catalog_items WHERE code = ? COLLATE NOCASE", code,
  );
  const stock = await all<{ warehouse: string; qty: number; as_of_wib: string | null }>(
    c.env.DB,
    `SELECT w.name AS warehouse, q.quantity AS qty, datetime(q.synced_at, '+7 hours') AS as_of_wib
       FROM accurate_stock q JOIN accurate_warehouses w ON w.entity = q.entity AND w.accurate_id = q.warehouse_id
      WHERE q.entity = ? AND q.item_code = ? COLLATE NOCASE`,
    entity, code,
  );
  const muts = await all<TimelineMutation & { warehouse: string }>(
    c.env.DB,
    `SELECT accurate_id AS id, warehouse, trans_type AS type, trans_number AS number, trans_date, created_wib, qty,
            removed_at IS NOT NULL AS removed
       FROM stock_mutations WHERE entity = ? AND item_no = ? COLLATE NOCASE ORDER BY created_wib DESC LIMIT 2000`,
    entity, code,
  );
  // Stok pembanding hanya untuk Admin dan Admin Gudang; peran lain melihat riwayat Accurate saja.
  const counts = !canUseStockBook(c.get("user")!.role) ? [] : await all<TimelineCount & { warehouse: string }>(
    c.env.DB,
    `SELECT s.id, s.warehouse, s.owner, s.counted, s.accurate_qty, datetime(s.counted_at, '+7 hours') AS counted_wib, s.status, u.name AS counted_by_name
       FROM stock_counts s LEFT JOIN users u ON u.id = s.counted_by
      WHERE s.code = ? COLLATE NOCASE ORDER BY s.counted_at DESC LIMIT 200`,
    code,
  );
  const historyFrom = await get<{ d: string | null }>(c.env.DB, "SELECT MIN(created_wib) AS d FROM stock_mutations WHERE entity = ?", entity);
  const names = [...new Set([...stock.map((r) => r.warehouse), ...muts.map((m) => m.warehouse), ...counts.map((k) => k.warehouse)])].filter(Boolean);
  const warehouses = names.map((w) => {
    const now = stock.find((r) => r.warehouse.toLowerCase() === w.toLowerCase());
    const mine = <T extends { warehouse: string }>(xs: T[]) => xs.filter((x) => x.warehouse.toLowerCase() === w.toLowerCase());
    const m = mine(muts).map((x) => ({ ...x, removed: !!x.removed }));
    return { warehouse: w, accurate: now?.qty ?? 0, asOf: now?.as_of_wib ?? null, events: buildTimeline(now?.qty ?? 0, now?.as_of_wib ?? null, m, mine(counts)) };
  }).sort((a, b) => (a.accurate < 0 ? -1 : 0) - (b.accurate < 0 ? -1 : 0) || b.events.length - a.events.length);
  // Hitungan lama tanpa gudang tetap ditampilkan, tanpa saldo.
  const noWarehouse = counts.filter((k) => !k.warehouse);
  return c.json({ item: item ?? { code, name: null, uom: "", stock: null }, warehouses, noWarehouse, historyFrom: historyFrom?.d ?? null });
});
