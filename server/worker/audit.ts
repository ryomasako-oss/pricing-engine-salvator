/* Append-only record of who changed what. Never updated or deleted. */

import { all, get, run } from "../db.d1";
import type { AuditEntry } from "../../shared/types";

export async function audit(
  d1: D1Database,
  actorId: number | null,
  entity: string,
  entityId: number,
  action: string,
  detail: unknown = "",
): Promise<void> {
  await run(
    d1,
    "INSERT INTO audit_log(actor_id, entity, entity_id, action, detail) VALUES(?, ?, ?, ?, ?)",
    actorId,
    entity,
    entityId,
    action,
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

export async function auditFor(
  d1: D1Database,
  entity: string,
  entityId: number,
  limit = 100,
): Promise<AuditEntry[]> {
  return all<AuditEntry>(
    d1,
    `SELECT a.id, COALESCE(u.name, 'Sistem') AS actor_name, a.entity, a.entity_id,
            a.action, a.detail, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity = ? AND a.entity_id = ?
      ORDER BY a.id DESC LIMIT ?`,
    entity,
    entityId,
    limit,
  );
}

export interface AuditFilter {
  /** UTC "YYYY-MM-DD HH:MM:SS" bounds, [start, end). */
  start: string;
  end: string;
  entity: string;
  /** Matches the action, the detail text or the actor's name. */
  q: string;
  limit: number;
  offset: number;
}

/** Riwayat Audit: newest first, filtered; `total` counts every match, not only this page. */
export async function auditSearch(d1: D1Database, f: AuditFilter): Promise<{ total: number; entries: AuditEntry[] }> {
  const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = `FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.created_at >= ?1 AND a.created_at < ?2
        AND (?3 = '' OR a.entity = ?3)
        AND (?4 = '%%' OR a.action LIKE ?4 ESCAPE '\\' OR a.detail LIKE ?4 ESCAPE '\\'
             OR COALESCE(u.name, 'Sistem') LIKE ?4 ESCAPE '\\')`;
  const params = [f.start, f.end, f.entity, like] as const;
  const [count, entries] = await Promise.all([
    get<{ n: number }>(d1, `SELECT COUNT(*) AS n ${where}`, ...params),
    all<AuditEntry>(
      d1,
      `SELECT a.id, COALESCE(u.name, 'Sistem') AS actor_name, a.entity, a.entity_id,
              a.action, a.detail, a.created_at
         ${where}
        ORDER BY a.id DESC LIMIT ?5 OFFSET ?6`,
      ...params, f.limit, f.offset,
    ),
  ]);
  return { total: count?.n ?? 0, entries };
}
