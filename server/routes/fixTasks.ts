import { Router } from "express";
import { all, get, run } from "../db.js";
import { audit } from "../audit.js";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { resolveTaskSchema, zodMessage } from "../validate.js";
import { hasPermission } from "../../shared/permissions.js";
import { FIX_KINDS, isFixKind } from "../../shared/fixTasks.js";
import { countTasksSql, listTasksSql, tasksForViewer, type FixTaskRow } from "../fixTasks.js";

/* "Perlu diperbaiki" (shared/fixTasks.ts). */
export const fixTasksRouter = Router();
fixTasksRouter.use(requireAuth);

fixTasksRouter.get("/", (req: AuthedRequest, res) => {
  const status = req.query.status === "done" ? "done" : "open";
  const { sql, scoped } = listTasksSql(req.user!.role, status);
  const rows = all<FixTaskRow>(sql, status, ...(scoped ? [req.user!.id, req.user!.id] : []));
  res.json({ tasks: tasksForViewer(req.user!.role, rows) });
});

fixTasksRouter.get("/count", (req: AuthedRequest, res) => {
  const { sql, scoped } = countTasksSql(req.user!.role);
  const row = get<{ n: number }>(sql, ...(scoped ? [req.user!.id, req.user!.id] : []));
  res.json({ open: row?.n ?? 0 });
});

fixTasksRouter.post("/:id/resolve", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const task = get<{ id: number; kind: string; status: string }>("SELECT id, kind, status FROM fix_tasks WHERE id = ?", id);
  if (!task || !isFixKind(task.kind)) {
    res.status(404).json({ error: "Tugas tidak ditemukan." });
    return;
  }
  if (!hasPermission(req.user!.role, FIX_KINDS[task.kind].permission)) {
    res.status(403).json({ error: "Tugas ini diselesaikan oleh manajer atau admin." });
    return;
  }
  if (task.status !== "open") {
    res.status(409).json({ error: "Tugas ini sudah diselesaikan." });
    return;
  }
  const parsed = resolveTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  run(
    `UPDATE fix_tasks SET status = 'done', resolved_by = ?, resolved_at = datetime('now'), resolution = ?
      WHERE id = ? AND status = 'open'`,
    req.user!.id, parsed.data.note, id,
  );
  audit(req.user!.id, "fix_task", id, "resolved", { kind: task.kind });
  res.json({ ok: true });
});
