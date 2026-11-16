/* ============================================================
   Endpoints FMS Salvator memanggil PE (docs/integrasi-pe-fms.md):
   - POST /api/integrations/fms/events   outbound.state_changed (F3.5)
   - GET  /api/integrations/fms/catalog  master barang (F4b)
   - GET  /api/integrations/fms/clients  master klien (F4b)
   Tanpa sesi login: setiap permintaan ditandatangani FMS (x-fms-*, FMS_PE_SECRET).
   ============================================================ */

import { Hono, type Context } from "hono";
import { all } from "../../db.d1";
import { chunks } from "../../sqlParams";
import { outboundStateChangedEvent } from "../../../shared/fmsContract";
import { applyFmsEvent, salesOrderEnabled, SO_DISABLED } from "../salesOrderService";
import { readBoundedBody, usableSecret, verifySignature } from "../fms/signing";
import type { Env } from "../env";

export const fmsIntegrationRouter = new Hono<Env>();

const NOT_CONFIGURED = "Integrasi FMS belum dikonfigurasi (FMS_PE_SECRET).";
const BAD_SIGNATURE = "Tanda tangan FMS tidak sah atau kedaluwarsa.";

fmsIntegrationRouter.post("/events", async (c) => {
  const secret = usableSecret(c.env.FMS_PE_SECRET);
  if (!secret) return c.json({ error: NOT_CONFIGURED }, 503);
  const raw = await readBoundedBody(c.req.raw);
  if (raw === null) return c.json({ error: "Body lebih dari 256 KB." }, 413);
  const ok = await verifySignature(secret, c.req.header("x-fms-timestamp"), c.req.header("x-fms-signature"), (ts) => `${ts}.${raw}`);
  if (!ok) return c.json({ error: BAD_SIGNATURE }, 401);
  // 503 = FMS retries later, so nothing is lost while the switch is off.
  if (!(await salesOrderEnabled(c.env.DB))) return c.json({ error: SO_DISABLED }, 503);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return c.json({ error: "Body bukan JSON." }, 400);
  }
  const parsed = outboundStateChangedEvent.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json({ error: `Event tidak sesuai kontrak: ${issue.path.join(".")} ${issue.message}` }, 422);
  }
  const r = await applyFmsEvent(c.env.DB, parsed.data);
  return r.status === 200 ? c.json(r.ack) : c.json({ error: r.error }, 422);
});

/* ---------------- F4b: master barang dan klien ---------------- */

const MAX_LIMIT = 500;

/** Checks the GET signature over `${ts}.GET ${path}?${query}` and the switch; a Response when refused. */
async function refuseGet(c: Context<Env>): Promise<Response | null> {
  const secret = usableSecret(c.env.FMS_PE_SECRET);
  if (!secret) return c.json({ error: NOT_CONFIGURED }, 503);
  const url = new URL(c.req.url);
  const ok = await verifySignature(
    secret,
    c.req.header("x-fms-timestamp"),
    c.req.header("x-fms-signature"),
    (ts) => `${ts}.${c.req.method} ${url.pathname}?${url.search.slice(1)}`,
  );
  if (!ok) return c.json({ error: BAD_SIGNATURE }, 401);
  if (!(await salesOrderEnabled(c.env.DB))) return c.json({ error: SO_DISABLED }, 503);
  return null;
}

/** since (ISO) as stored by datetime('now'), cursor (last id seen), limit (1..500). Null when malformed. */
function pageParams(c: Context<Env>): { since: string | null; cursor: number; limit: number } | null {
  const since = c.req.query("since");
  const cursor = c.req.query("cursor");
  const limit = c.req.query("limit");
  let sinceSql: string | null = null;
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) return null;
    sinceSql = d.toISOString().slice(0, 19).replace("T", " ");
  }
  const cur = cursor ? Number(cursor) : 0;
  const lim = limit ? Number(limit) : MAX_LIMIT;
  if (!Number.isInteger(cur) || cur < 0 || !Number.isInteger(lim) || lim < 1) return null;
  return { since: sinceSql, cursor: cur, limit: Math.min(lim, MAX_LIMIT) };
}

const BAD_PAGE = "Parameter since/cursor/limit tidak sah.";

fmsIntegrationRouter.get("/catalog", async (c) => {
  const refused = await refuseGet(c);
  if (refused) return refused;
  const p = pageParams(c);
  if (!p) return c.json({ error: BAD_PAGE }, 400);
  // No cogs, list_price or stock: price and stock data stay in PE.
  const rows = await all<{ id: number; code: string; name: string; uom: string; category: string; updated_at: string }>(
    c.env.DB,
    `SELECT id, code, name, uom, category, strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at
       FROM catalog_items WHERE (?1 IS NULL OR updated_at > ?1) AND id > ?2 ORDER BY id LIMIT ?3`,
    p.since, p.cursor, p.limit + 1,
  );
  const page = rows.slice(0, p.limit);
  const uoms: { code: string; uom: string; factor: number }[] = [];
  for (const chunk of chunks(page.map((r) => r.code))) {
    uoms.push(
      ...(await all<{ code: string; uom: string; factor: number }>(
        c.env.DB,
        `SELECT code, uom, factor FROM catalog_item_uoms WHERE code IN (${chunk.map(() => "?").join(",")}) ORDER BY code, factor`,
        ...chunk,
      )),
    );
  }
  return c.json({
    items: page.map(({ id: _id, ...r }) => r),
    uoms,
    nextCursor: rows.length > p.limit ? String(page[page.length - 1].id) : null,
  });
});

fmsIntegrationRouter.get("/clients", async (c) => {
  const refused = await refuseGet(c);
  if (refused) return refused;
  const p = pageParams(c);
  if (!p) return c.json({ error: BAD_PAGE }, 400);
  const rows = await all<{ id: number; code: string; name: string; address: string; contact_name: string; contact_phone: string; updated_at: string }>(
    c.env.DB,
    `SELECT id, code, name, address, contact_name, contact_phone,
            strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(updated_at, created_at)) AS updated_at
       FROM clients WHERE (?1 IS NULL OR COALESCE(updated_at, created_at) > ?1) AND id > ?2 ORDER BY id LIMIT ?3`,
    p.since, p.cursor, p.limit + 1,
  );
  const page = rows.slice(0, p.limit);
  return c.json({
    clients: page.map(({ id: _id, ...r }) => r),
    nextCursor: rows.length > p.limit ? String(page[page.length - 1].id) : null,
  });
});
