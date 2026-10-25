import { Hono } from "hono";
import { all, batch, get, run, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth } from "../auth";
import { zodMessage } from "../../validate";
import {
  FAMILIARITY_SCHEMA_STATEMENTS,
  FamiliarityError,
  createFamiliaritySession,
  feedInputSchema,
  readFamiliaritySession,
  resolveFamiliarityRow,
  resolveInputSchema,
  type FamiliarityStore,
} from "../../familiarity";
import { parseFamiliarityFile, type FamiliarityFile, type FamiliarityInputLine } from "../../../shared/familiarityParse";
import type { Env } from "../env";

/* Interactive familiarity on D1.
   The service does the thinking; this file only adapts Hono/HTTP. */

export const familiarityRouter = new Hono<Env>();
familiarityRouter.use(requireAuth);

let schemaReady = false;

/** Also called by /catalog/match, which reads familiarity_rules. */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await batch(db, FAMILIARITY_SCHEMA_STATEMENTS.map((sql) => stmt(db, sql)));
  schemaReady = true;
}

function storeOf(db: D1Database): FamiliarityStore {
  return {
    all: <T>(sql: string, ...params: (string | number | null)[]) => all<T>(db, sql, ...params),
    get: <T>(sql: string, ...params: (string | number | null)[]) => get<T>(db, sql, ...params),
    run: async (sql: string, ...params: (string | number | null)[]) => {
      const r = await run(db, sql, ...params);
      return { changes: Number(r.meta.changes), lastId: Number(r.meta.last_row_id) };
    },
  };
}

function parseClientId(db: D1Database, value: unknown): Promise<number | null> {
  if (value === undefined || value === null || value === "") return Promise.resolve(null);
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return Promise.reject(new FamiliarityError(400, "client_id tidak valid."));
  return get(db, "SELECT id FROM clients WHERE id = ?", id).then((row) =>
    row ? id : Promise.reject(new FamiliarityError(400, "Klien tidak ditemukan.")),
  );
}

function fail(c: any, err: unknown) {
  if (err instanceof FamiliarityError) return c.json({ error: err.message }, err.status as 400);
  return c.json({ error: err instanceof Error ? err.message : "Input tidak valid." }, 400);
}

function isFile(value: unknown): value is FamiliarityFile {
  return !!value && typeof value === "object" && typeof (value as FamiliarityFile).arrayBuffer === "function";
}

async function readFeed(c: any): Promise<{ body: unknown; file?: FamiliarityFile }> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return { body: await c.req.json().catch(() => null) };
  }
  const form = await c.req.formData();
  const raw = form.get("raw_lines");
  let rawLines: unknown = undefined;
  if (typeof raw === "string" && raw.trim()) {
    try {
      rawLines = JSON.parse(raw);
    } catch {
      throw new FamiliarityError(400, "raw_lines harus berupa JSON array.");
    }
  }
  const file = form.get("file");
  return {
    body: {
      client_id: form.get("client_id") ?? undefined,
      title: form.get("title") ?? undefined,
      raw_lines: rawLines,
    },
    file: isFile(file) ? file : undefined,
  };
}

familiarityRouter.post("/feed", async (c) => {
  const user = c.get("user")!;
  await ensureSchema(c.env.DB);
  try {
    const { body, file } = await readFeed(c);
    const parsed = feedInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
    const clientId = await parseClientId(c.env.DB, parsed.data.client_id);
    const fileLines: FamiliarityInputLine[] = file ? (await parseFamiliarityFile(file)).lines : [];
    const lines = [...(parsed.data.raw_lines ?? []), ...fileLines];
    if (!lines.length) return c.json({ error: "Isi raw_lines atau unggah file Excel/CSV." }, 400);
    const source = file && parsed.data.raw_lines?.length ? "mixed" : file ? "file" : "text";
    const view = await createFamiliaritySession(
      storeOf(c.env.DB),
      { clientId, title: parsed.data.title ?? "", source, lines },
      user,
    );
    await audit(c.env.DB, user.id, "familiarity", view.session_id, "feed", {
      client_id: clientId,
      rows: view.summary.total,
      source,
    });
    return c.json({ session_id: view.session_id, summary: view.summary, rows: view.rows });
  } catch (err) {
    return fail(c, err);
  }
});

familiarityRouter.get("/sessions/:sessionId", async (c) => {
  const user = c.get("user")!;
  await ensureSchema(c.env.DB);
  const id = Number(c.req.param("sessionId"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Sesi familiarity tidak ditemukan." }, 404);
  const view = await readFamiliaritySession(storeOf(c.env.DB), id, user);
  if (!view) return c.json({ error: "Sesi familiarity tidak ditemukan." }, 404);
  return c.json({ session_id: view.session_id, summary: view.summary, rows: view.rows });
});

familiarityRouter.patch("/sessions/:sessionId/resolve", async (c) => {
  const user = c.get("user")!;
  await ensureSchema(c.env.DB);
  const id = Number(c.req.param("sessionId"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Sesi familiarity tidak ditemukan." }, 404);
  const parsed = resolveInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  try {
    const result = await resolveFamiliarityRow(storeOf(c.env.DB), id, parsed.data, user);
    await audit(c.env.DB, user.id, "familiarity", id, "resolve", {
      row_id: parsed.data.row_id,
      action: parsed.data.action,
      updated: result.rows.length,
    });
    return c.json(result);
  } catch (err) {
    return fail(c, err);
  }
});
