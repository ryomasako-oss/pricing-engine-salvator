import { Hono } from "hono";
import { all } from "../../db.d1";
import { auditSearch } from "../audit";
import { wibRangeUtc } from "../../../shared/auditLog";
import { requireAuth, requirePermission } from "../auth";
import type { Env } from "../env";

export const approvalsRouter = new Hono<Env>();
approvalsRouter.use(requireAuth);

approvalsRouter.get("/", requirePermission("decide_quotes"), async (c) => {
  const decision = c.req.query("decision") ?? "pending";
  const rows = await all<any>(
    c.env.DB,
    `SELECT a.id, a.quote_id, a.decision, a.note, a.requested_at, a.decided_at,
            a.breaches, a.monthly_value, a.net_margin,
            q.number AS quote_number, q.title AS quote_title, q.status AS quote_status,
            c.name AS client_name,
            ru.name AS requested_by_name, du.name AS decided_by_name
       FROM approvals a
       JOIN quotes q ON q.id = a.quote_id
       LEFT JOIN clients c ON c.id = q.client_id
       LEFT JOIN users ru ON ru.id = a.requested_by
       LEFT JOIN users du ON du.id = a.decided_by
      ${decision === "all" ? "" : "WHERE a.decision = ?"}
      ORDER BY a.id DESC LIMIT 200`,
    ...(decision === "all" ? [] : [decision]),
  );
  const approvals = rows.map((a) => ({ ...a, breaches: JSON.parse(a.breaches || "[]") }));
  return c.json({ approvals });
});

const AUDIT_PAGE_SIZE = 100;

/* Riwayat Audit. Details carry COGS (catalog edits), so view_costs too, should the two ever part. */
approvalsRouter.get("/audit", requirePermission("view_audit"), requirePermission("view_costs"), async (c) => {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const valid = (d: string) => day.test(d) && !Number.isNaN(Date.parse(d));
  if (!valid(from) || !valid(to) || from > to) return c.json({ error: "Rentang tanggal tidak valid." }, 400);
  const [start, end] = wibRangeUtc(from, to);
  // shortcut: export takes at most 5000 rows in one response; page it if a range ever holds more.
  const exportAll = c.req.query("all") === "1";
  const pageSize = exportAll ? 5000 : AUDIT_PAGE_SIZE;
  const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
  const result = await auditSearch(c.env.DB, {
    start,
    end,
    entity: (c.req.query("entity") ?? "").slice(0, 40),
    q: (c.req.query("q") ?? "").trim().slice(0, 100),
    limit: pageSize,
    offset: exportAll ? 0 : (page - 1) * pageSize,
  });
  return c.json({ ...result, page: exportAll ? 1 : page, pageSize });
});
