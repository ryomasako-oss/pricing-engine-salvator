import { Hono } from "hono";
import { all, get, run } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth } from "../auth";
import { resolveTaskSchema, zodMessage } from "../../validate";
import { hasPermission } from "../../../shared/permissions";
import { FIX_KINDS, isFixKind } from "../../../shared/fixTasks";
import { countTasksSql, listTasksSql, tasksForViewer, type FixTaskRow } from "../../fixTasks";
import type { Env } from "../env";

/* "Perlu diperbaiki" (shared/fixTasks.ts). */
export const fixTasksRouter = new Hono<Env>();
fixTasksRouter.use(requireAuth);

fixTasksRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const status = c.req.query("status") === "done" ? "done" : "open";
  const { sql, scoped } = listTasksSql(user.role, status);
  const rows = await all<FixTaskRow>(c.env.DB, sql, status, ...(scoped ? [user.id, user.id] : []));
  return c.json({ tasks: tasksForViewer(user.role, rows) });
});

fixTasksRouter.get("/count", async (c) => {
  const user = c.get("user")!;
  const { sql, scoped } = countTasksSql(user.role);
  const row = await get<{ n: number }>(c.env.DB, sql, ...(scoped ? [user.id, user.id] : []));
  return c.json({ open: row?.n ?? 0 });
});

fixTasksRouter.post("/:id/resolve", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const task = await get<{ id: number; kind: string; status: string }>(c.env.DB, "SELECT id, kind, status FROM fix_tasks WHERE id = ?", id);
  if (!task || !isFixKind(task.kind)) return c.json({ error: "Tugas tidak ditemukan." }, 404);
  if (!hasPermission(user.role, FIX_KINDS[task.kind].permission)) {
    return c.json({ error: "Tugas ini diselesaikan oleh manajer atau admin." }, 403);
  }
  if (task.status !== "open") return c.json({ error: "Tugas ini sudah diselesaikan." }, 409);
  const parsed = resolveTaskSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  await run(
    c.env.DB,
    `UPDATE fix_tasks SET status = 'done', resolved_by = ?, resolved_at = datetime('now'), resolution = ?
      WHERE id = ? AND status = 'open'`,
    user.id, parsed.data.note, id,
  );
  await audit(c.env.DB, user.id, "fix_task", id, "resolved", { kind: task.kind });
  return c.json({ ok: true });
});
