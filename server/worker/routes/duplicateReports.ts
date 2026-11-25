import { Hono } from "hono";
import { all, batch, get, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { zodMessage } from "../../validate";
import { hasPermission } from "../../../shared/permissions";
import type { DuplicateReport } from "../../../shared/duplicateReports";
import type { ArchivedItem } from "../../../shared/catalogArchive";
import { archiveLosersSql, archivedByIdsSql } from "../../catalogArchive";
import { catalogEntity } from "../accurate/sync";
import { forgetCatalogIndex } from "../catalogSearchIndex";
import {
  countDuplicateSql,
  DECIDE_DUPLICATE_SQL,
  decideDuplicateSchema,
  duplicateReportSchema,
  GET_DUPLICATE_SQL,
  GROUP_OPEN_SQL,
  INSERT_DUPLICATE_SQL,
  itemsByIdsSql,
  listDuplicateSql,
  pairForInsert,
} from "../../duplicateReports";
import type { Env } from "../env";

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
  // Barang yang diarsipkan ACC laporan-laporan ini, beserta status "Nonaktifkan di Accurate" (dihitung saat dibaca).
  const ids = [...new Set(rows.filter((r) => r.status === "approved").flatMap((r) => [r.item_a_id, r.item_b_id]))];
  const archived: ArchivedItem[] = [];
  for (let i = 0; i < ids.length; i += 90)
    archived.push(...(await all<ArchivedItem>(c.env.DB, archivedByIdsSql(Math.min(90, ids.length - i)), catalogEntity(c.env), ...ids.slice(i, i + 90))));
  return c.json({ items: rows, archived });
});

duplicateReportsRouter.post("/", async (c) => {
  const user = c.get("user")!;
  if (!hasPermission(user.role, "draft_catalog") && !hasPermission(user.role, "edit_catalog"))
    return c.json({ error: "Akun ini tidak bisa melaporkan duplikat." }, 403);
  const parsed = duplicateReportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { item_ids, note } = parsed.data;
  const found = await all<{ id: number }>(c.env.DB, itemsByIdsSql(item_ids.length), ...item_ids);
  if (found.length < item_ids.length) return c.json({ error: "Ada barang yang tidak ditemukan di katalog." }, 400);
  const [anchor, ...others] = item_ids;
  const pairs = others.map((other) => pairForInsert(anchor, other));
  const open = await all<{ item_a_id: number; item_b_id: number }>(c.env.DB,
    "SELECT item_a_id, item_b_id FROM duplicate_reports WHERE status = 'open'");
  const fresh = pairs.filter(([a, b]) => !open.some((o) => o.item_a_id === a && o.item_b_id === b));
  if (!fresh.length) return c.json({ error: "Barang-barang ini sudah dilaporkan dan masih menunggu ACC." }, 409);
  const groupKey = crypto.randomUUID();
  try {
    await batch(c.env.DB, fresh.map(([a, b]) => stmt(c.env.DB, INSERT_DUPLICATE_SQL, note, user.id, groupKey, a, b)));
  } catch (e) {
    // Laporan bersamaan untuk pasangan yang sama: index unik menolak yang kedua (seluruh batch batal).
    if (String(e).includes("UNIQUE")) return c.json({ error: "Barang-barang ini sudah dilaporkan dan masih menunggu ACC." }, 409);
    throw e;
  }
  await audit(c.env.DB, user.id, "duplicate_report", 0, "created", { group_key: groupKey, item_ids, note, skipped: pairs.length - fresh.length });
  return c.json({ group_key: groupKey, count: fresh.length, skipped: pairs.length - fresh.length }, 201);
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
  const rows = await all<{ item_a_id: number; item_b_id: number }>(c.env.DB, GROUP_OPEN_SQL, report.group_key);
  const members = new Set(rows.flatMap((r) => [r.item_a_id, r.item_b_id]));
  if (decision === "approved" && (keep_item_id === undefined || !members.has(keep_item_id)))
    return c.json({ error: "Barang yang dipilih bukan bagian dari laporan ini." }, 400);
  const decide = stmt(c.env.DB, DECIDE_DUPLICATE_SQL,
    decision, decision === "approved" ? keep_item_id ?? null : null, user.id, note, report.group_key);
  // ACC: barang lain di kelompok diarsipkan (disembunyikan, bukan dihapus) dalam batch yang sama dengan keputusannya.
  const losers = decision === "approved" ? [...members].filter((m) => m !== keep_item_id) : [];
  const [change] = await batch(c.env.DB, [
    decide,
    ...(losers.length
      ? [stmt(c.env.DB, archiveLosersSql(losers.length), user.id, keep_item_id!, ...losers, keep_item_id!, report.group_key, keep_item_id!, user.id)]
      : []),
  ]);
  if (change.meta.changes === 0) return c.json({ error: "Laporan sudah diputuskan." }, 409);
  // Barang yang diarsipkan harus langsung hilang dari pencarian di isolate ini (indeks di-cache).
  forgetCatalogIndex();
  await audit(c.env.DB, user.id, "duplicate_report", id, "decided", {
    decision, group_key: report.group_key, kept_item_id: keep_item_id ?? null, archived_item_ids: losers,
  });
  return c.json({ ok: true });
});
