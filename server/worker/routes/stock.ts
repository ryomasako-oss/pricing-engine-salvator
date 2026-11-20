/* Stok di Pricing Engine (pemilik, 2026-11-20): Tarik (Accurate -> Pricing Engine), Cocokkan (bandingkan),
   status Kirim, dan riwayat stok. Kirim belum menulis ke Accurate sama sekali (klien Accurate hanya-baca).
   Draf stok dan ACC-nya ada di routes/catalog.ts. Tidak ada COGS atau harga di sini: role gudang tidak
   punya view_costs. */

import { Hono } from "hono";
import { z } from "zod";
import { all, get } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth } from "../auth";
import { hasPermission } from "../../../shared/permissions";
import { zodMessage } from "../../validate";
import { ACCURATE_TOTALS, IS_UNSENT, SAME_UNIT, pullStock } from "../accurate/stock";
import { catalogEntity, credsFor, loadState, requestRestart, syncConfig, syncStep } from "../accurate/sync";
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
  return c.json({ pushEnabled: flag?.value === "1", unsent: await unsentCount(c.env.DB) });
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
  await audit(c.env.DB, user.id, "stock", 0, "stock_pulled", { entity, ...r });
  return c.json({ done: true, ...r, asOf: st.last_success_at });
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

/** Riwayat stok: one item (`code`) or the latest across all items. */
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
      ${code ? "WHERE h.code = ? COLLATE NOCASE" : ""}
      ORDER BY h.id DESC LIMIT ${code ? 100 : 200}`,
    ...(code ? [code] : []),
  );
  return c.json({ history: rows });
});
