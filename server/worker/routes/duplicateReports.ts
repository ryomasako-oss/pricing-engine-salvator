import { Hono } from "hono";
import { all, get, run } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { zodMessage } from "../../validate";
import { hasPermission } from "../../../shared/permissions";
import type { DuplicateReport } from "../../../shared/duplicateReports";
import {
  countDuplicateSql,
  DECIDE_DUPLICATE_SQL,
  decideDuplicateSchema,
  duplicateReportSchema,
  GET_DUPLICATE_SQL,
  INSERT_DUPLICATE_SQL,
  ITEMS_BY_IDS_SQL,
  listDuplicateSql,
  pairForInsert,
} from "../../duplicateReports";
import type { Env } from "../env";

/* NOTE FOR LATER: once the live Gudang code (src/pages/Gudang.tsx +
   its draft routes) is pushed to this repo, this whole feature can move
   into Gudang as a tab: mount this router under /api/gudang/duplicate-
   reports instead, and render DuplicateReports.tsx as a tab inside
   Gudang.tsx (the page already has Menunggu / Riwayat tabs) — no new
   backend work is needed. */

export const duplicateReportsRouter = new Hono<Env>();
duplicateReportsRouter.use(requireAuth);

duplicateReportsRouter.get("/count", async (c) => {
  const user = c.get("user")!;
  const scoped = !hasPermission(user.role, "edit_catalog");
  const row = await get<{ n: number }>(c.env.DB, countDuplicateSql(scoped), ...(scoped ? [user.id] : []));
  return c.json({ open: row?.n ?? 0 });
});

duplicateReportsRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const q = c.req.query("status");
  const status = q === "decided" ? "decided" : q === "all" ? "all" : "open";
  // Mirrors pendingItems: staff see only their own reports,
  // anyone who can edit the catalog sees all of them.
  const scoped = !hasPermission(user.role, "edit_catalog");
  const rows = await all<DuplicateReport>(c.env.DB, listDuplicateSql(status, scoped), ...(scoped ? [user.id] : []));
  return c.json({ items: rows });
});

duplicateReportsRouter.post("/", async (c) => {
  const user = c.get("user")!;
  if (!hasPermission(user.role, "draft_catalog") && !hasPermission(user.role, "edit_catalog"))
    return c.json({ error: "Akun ini tidak bisa melaporkan duplikat." }, 403);
  const parsed = duplicateReportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { item_a_id, item_b_id, note } = parsed.data;
  const [a, b] = pairForInsert(item_a_id, item_b_id);
  const items = await all<{ id: number }>(c.env.DB, ITEMS_BY_IDS_SQL, a, b);
  if (items.length < 2) return c.json({ error: "Barang tidak ditemukan." }, 400);
  const existing = await get(c.env.DB,
    "SELECT id FROM duplicate_reports WHERE item_a_id = ? AND item_b_id = ? AND status = 'open'", a, b);
  if (existing) return c.json({ error: "Pasangan ini sudah dilaporkan dan masih menunggu." }, 409);
  let result;
  try {
    result = await run(c.env.DB, INSERT_DUPLICATE_SQL, note, user.id, a, b);
  } catch (e) {
    // Dua laporan bersamaan untuk pasangan yang sama: index unik menolak yang kedua.
    if (String(e).includes("UNIQUE")) return c.json({ error: "Pasangan ini sudah dilaporkan dan masih menunggu." }, 409);
    throw e;
  }
  const id = Number(result.meta.last_row_id);
  const row = await get<DuplicateReport>(c.env.DB, GET_DUPLICATE_SQL, id);
  await audit(c.env.DB, user.id, "duplicate_report", id, "created", { item_a_id: a, item_b_id: b, note });
  return c.json({ item: row }, 201);
});

duplicateReportsRouter.post("/:id/decide", requirePermission("review_catalog_drafts"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Id tidak valid." }, 400);
  const report = await get<DuplicateReport>(c.env.DB, GET_DUPLICATE_SQL, id);
  if (!report) return c.json({ error: "Laporan tidak ditemukan." }, 404);
  if (report.status !== "open") return c.json({ error: "Laporan sudah diputuskan." }, 409);
  const parsed = decideDuplicateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { decision, keep_item_id, note } = parsed.data;
  if (decision === "approved" && keep_item_id !== report.item_a_id && keep_item_id !== report.item_b_id)
    return c.json({ error: "Barang yang dipilih bukan bagian dari pasangan ini." }, 400);
  const change = await run(c.env.DB, DECIDE_DUPLICATE_SQL,
    decision, decision === "approved" ? keep_item_id ?? null : null, user.id, note, id);
  if (change.meta.changes === 0) return c.json({ error: "Laporan sudah diputuskan." }, 409);
  await audit(c.env.DB, user.id, "duplicate_report", id, "decided", { decision, kept_item_id: keep_item_id ?? null });
  return c.json({ ok: true });
});
