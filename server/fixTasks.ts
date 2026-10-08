/* SQL for "Perlu diperbaiki" (shared/fixTasks.ts), used by both backends
   so Express and the Worker store, scope and show tasks the same way. */

import { dedupeKey, type NewFixTask, type FixKind } from "../shared/fixTasks.js";
import type { Role } from "../shared/types.js";
import { canSeeCosts } from "./staffView.js";

/**
 * Inserts a JSON array of tasks in one statement, skipping any problem that
 * is already open (WHERE NOT EXISTS, safe on D1). One statement per chunk,
 * not per task: D1 on the Free plan allows 50 queries per invocation, and a
 * client's list can have many rows with no catalog item.
 */
export const INSERT_TASKS_SQL = `
  INSERT INTO fix_tasks(kind, quote_id, line_id, code, item_name, qty, uom, detail, dedupe, created_by)
  SELECT json_extract(j.value, '$.kind'), json_extract(j.value, '$.quote_id'), json_extract(j.value, '$.line_id'),
         json_extract(j.value, '$.code'), json_extract(j.value, '$.item_name'), json_extract(j.value, '$.qty'),
         json_extract(j.value, '$.uom'), json_extract(j.value, '$.detail'), json_extract(j.value, '$.dedupe'), ?
    FROM json_each(?) AS j
   WHERE NOT EXISTS (SELECT 1 FROM fix_tasks f WHERE f.dedupe = json_extract(j.value, '$.dedupe') AND f.status = 'open')`;

export const TASKS_PER_STATEMENT = 250;

/**
 * [userId, json] per statement. Duplicates within the batch are dropped
 * first: the open-dedupe unique index would otherwise refuse the whole insert.
 */
export function insertTasksParams(tasks: NewFixTask[], userId: number | null): [number | null, string][] {
  const seen = new Set<string>();
  const rows = [];
  for (const t of tasks) {
    const dedupe = dedupeKey(t);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({
      kind: t.kind, quote_id: t.quote_id, line_id: t.line_id, code: t.code.slice(0, 64), item_name: t.item_name.slice(0, 300),
      qty: t.qty, uom: t.uom.slice(0, 32), detail: t.detail.slice(0, 1000), dedupe,
    });
  }
  const out: [number | null, string][] = [];
  for (let i = 0; i < rows.length; i += TASKS_PER_STATEMENT) out.push([userId, JSON.stringify(rows.slice(i, i + TASKS_PER_STATEMENT))]);
  return out;
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

/**
 * Staff get no COGS figures: a COGS task's detail is the catalog's problem
 * text, which names them, and the note a manager closes it with naturally
 * does too ("COGS dikoreksi dari Rp ... ke Rp ..."). A cross-check task names
 * catalog COGS too ("katalog Rp 9.500"); staff never list those (they belong
 * to no quote), and this keeps it so if that ever changes.
 */
export function tasksForViewer<T extends FixTaskRow>(role: Role, rows: T[]): T[] {
  if (canSeeCosts(role)) return rows;
  return rows.map((r) => {
    if (r.kind === "accurate_check") {
      return { ...r, detail: "Selisih katalog dengan Accurate, dicek manajer.", ...("resolution" in r ? { resolution: null } : {}) };
    }
    if (r.kind !== "cogs_held") return r;
    const done = r.status === "done";
    return {
      ...r,
      detail: done ? "COGS item ini sudah dicek manajer." : "COGS item ini sedang dicek manajer.",
      ...("resolution" in r ? { resolution: done ? "Sudah ditangani manajer." : null } : {}),
    };
  });
}
