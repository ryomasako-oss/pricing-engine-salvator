/* Test helpers for the Accurate sync: a fake Accurate API and a D1 wrapper
   that counts queries the way Cloudflare bills them. Test-only; nothing in
   the Worker imports this file. */

/**
 * Counts D1 queries. Cloudflare: "limits for individual queries apply to each
 * individual statement contained within a batch" (D1 limits), so a batch of N
 * statements is N queries, not one round trip. Counting a batch as 1 let a
 * sync that inserted a row per statement (520 queries in the worst tick) pass
 * the budget test.
 */
export function countQueries(raw: D1Database): { db: D1Database; queries: () => number; reset: () => void } {
  let d1 = 0;
  let inBatch = false;
  const count = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(t, k) {
        const f = (t as unknown as Record<string | symbol, unknown>)[k];
        if (k === "bind") return (...a: unknown[]) => count((f as (...x: unknown[]) => D1PreparedStatement).apply(t, a));
        if (k === "run" || k === "all" || k === "first")
          return (...a: unknown[]) => (inBatch || d1++, (f as (...x: unknown[]) => unknown).apply(t, a));
        return typeof f === "function" ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    });
  const db = new Proxy(raw, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => count(t.prepare(sql));
      if (k === "batch")
        return async (sts: D1PreparedStatement[]) => {
          d1 += sts.length;
          inBatch = true;
          try {
            return await t.batch(sts);
          } finally {
            inBatch = false;
          }
        };
      const f = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof f === "function" ? (f as (...x: unknown[]) => unknown).bind(t) : f;
    },
  }) as D1Database;
  return { db, queries: () => d1, reset: () => void (d1 = 0) };
}

export function fakeAccurate(opts: { items: Record<string, unknown>[]; stock: Record<number, Record<string, unknown>[]>; moveHost?: boolean }) {
  const log: string[] = [];
  let moved = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const page = <T,>(rows: T[], url: URL) => {
    const p = Number(url.searchParams.get("sp.page") ?? 1);
    const size = Number(url.searchParams.get("sp.pageSize") ?? 20);
    return json({ s: true, d: rows.slice((p - 1) * size, p * size), sp: { page: p, pageSize: size, pageCount: Math.max(1, Math.ceil(rows.length / size)), rowCount: rows.length } });
  };
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    if (!h.get("authorization")?.startsWith("Bearer ") || !h.get("x-api-signature") || !h.get("x-api-timestamp")) {
      return json({ s: false, d: ["Unauthorized"] }, 401);
    }
    log.push(`${init?.method} ${url.host}${url.pathname}`);
    if (url.pathname === "/api/api-token.do") {
      return json({ s: true, d: { "data usaha": { host: "https://zeus.accurate.id", alias: "CV Test", id: 1 } } });
    }
    if (opts.moveHost && url.host === "zeus.accurate.id" && !moved) {
      moved = true;
      return new Response(null, { status: 308, headers: { location: `https://hera.accurate.id${url.pathname}${url.search}` } });
    }
    if (url.pathname.endsWith("/item/list.do")) return page(opts.items, url);
    if (url.pathname.endsWith("/warehouse/list.do")) return page([{ id: 1, name: "Gudang Utama" }, { id: 2, name: "Bogor" }], url);
    if (url.pathname.endsWith("/item/list-stock.do")) return page(opts.stock[Number(url.searchParams.get("warehouseId"))] ?? [], url);
    return json({ s: false, d: ["not found"] }, 404);
  };
  return { impl, log };
}

