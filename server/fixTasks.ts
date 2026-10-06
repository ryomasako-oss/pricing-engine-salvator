/* SQL for "Perlu diperbaiki" (shared/fixTasks.ts), used by both backends
   so Express and the Worker store, scope and show tasks the same way. */

import { dedupeKey, type NewFixTask, type FixKind } from "../shared/fixTasks.js";
import type { Role } from "../shared/types.js";
import { canSeeCosts } from "./staffView.js";

/** Insert unless the same problem is already open (WHERE NOT EXISTS, safe on D1). */
export const INSERT_TASK_SQL = `
  INSERT INTO fix_tasks(kind, quote_id, line_id, code, item_name, qty, uom, detail, dedupe, created_by)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM fix_tasks WHERE dedupe = ? AND status = 'open')`;

export function insertTaskParams(t: NewFixTask, userId: number | null) {
  const key = dedupeKey(t);
  return [t.kind, t.quote_id, t.line_id, t.code, t.item_name.slice(0, 300), t.qty, t.uom.slice(0, 32), t.detail.slice(0, 1000), key, userId, key] as const;
}

const BASE = `
  SELECT t.id, t.kind, t.quote_id, t.line_id, t.code, t.item_name, t.qty, t.uom, t.detail, t.status,
         t.created_at, t.resolved_at, t.resolution,
         q.number AS quote_number, q.title AS quote_title, c.name AS client_name,
         cu.name AS created_by_name, ru.name AS resolved_by_name
    FROM fix_tasks t
    LEFT JOIN quotes q ON q.id = t.quote_id
    LEFT JOIN clients c ON c.id = q.client_id
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users ru ON ru.id = t.resolved_by`;

/** Managers/admins see every task; staff see the tasks on quotes they own or were given. */
export function listTasksSql(role: Role, status: "open" | "done"): { sql: string; scoped: boolean } {
  const scoped = !canSeeCosts(role);
  const order = status === "open" ? "t.created_at ASC, t.id ASC" : "t.resolved_at DESC, t.id DESC";
  return {
    scoped,
    sql: `${BASE} WHERE t.status = ?${scoped ? " AND (q.created_by = ? OR q.assigned_to = ?)" : ""} ORDER BY ${order} LIMIT 500`,
  };
}

export function countTasksSql(role: Role): { sql: string; scoped: boolean } {
  const scoped = !canSeeCosts(role);
  return {
    scoped,
    sql: `SELECT COUNT(*) AS n FROM fix_tasks t LEFT JOIN quotes q ON q.id = t.quote_id
           WHERE t.status = 'open'${scoped ? " AND (q.created_by = ? OR q.assigned_to = ?)" : ""}`,
  };
}

export const OPEN_TASKS_FOR_DIGEST_SQL = `${BASE} WHERE t.status = 'open' ORDER BY t.created_at ASC, t.id ASC LIMIT 200`;

export interface FixTaskRow {
  id: number;
  kind: FixKind;
  detail: string;
  [k: string]: unknown;
}

/** Staff get no COGS figures: a COGS task's detail is the catalog's problem text, which names them. */
export function tasksForViewer<T extends FixTaskRow>(role: Role, rows: T[]): T[] {
  if (canSeeCosts(role)) return rows;
  return rows.map((r) => (r.kind === "cogs_held" ? { ...r, detail: "COGS item ini sedang dicek manajer." } : r));
}
