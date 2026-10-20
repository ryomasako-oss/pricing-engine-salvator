import express, { Router, type NextFunction, type Request, type Response } from "express";
import { db, all, get, run } from "../db.js";
import { audit } from "../audit.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { zodMessage } from "../validate.js";
import {
  FAMILIARITY_SCHEMA,
  FamiliarityError,
  createFamiliaritySession,
  feedInputSchema,
  readFamiliaritySession,
  resolveFamiliarityRow,
  resolveInputSchema,
  type FamiliarityStore,
} from "../familiarity.js";
import { parseFamiliarityFile, type FamiliarityFile, type FamiliarityInputLine } from "../../shared/familiarityParse.js";

/* Interactive familiarity: the HTTP shell around server/familiarity.ts.
   The Worker route is the twin; both call the same service. */

export const familiarityRouter = Router();
familiarityRouter.use(requireAuth);

let schemaReady = false;
/** Also called by /catalog/match, which reads familiarity_rules. */
export function ensureSchema() {
  if (schemaReady) return;
  db.exec(FAMILIARITY_SCHEMA);
  schemaReady = true;
}

const store: FamiliarityStore = {
  all: async <T>(sql: string, ...params: (string | number | null)[]) =>
    all<T>(sql, ...params) as T[],
  get: async <T>(sql: string, ...params: (string | number | null)[]) =>
    get<T>(sql, ...params) as T | undefined,
  run: async (sql: string, ...params: (string | number | null)[]) => {
    const r = run(sql, ...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  },
};

type AsyncHandler = (req: AuthedRequest, res: Response) => Promise<void>;

const wrap =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req as AuthedRequest, res).catch(next);
  };

function parseClientId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new FamiliarityError(400, "client_id tidak valid.");
  if (!get("SELECT id FROM clients WHERE id = ?", id)) throw new FamiliarityError(400, "Klien tidak ditemukan.");
  return id;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof FamiliarityError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : "Input tidak valid." });
}

function isFile(value: unknown): value is FamiliarityFile {
  return !!value && typeof value === "object" && typeof (value as FamiliarityFile).arrayBuffer === "function";
}

/** JSON body, or the same fields in a multipart form (optionally with a file). */
async function readFeed(req: Request): Promise<{ body: unknown; file?: FamiliarityFile }> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("multipart/form-data")) return { body: req.body };

  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
  const form = await new Response(new Uint8Array(bytes), { headers: { "content-type": contentType } }).formData();
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

familiarityRouter.post(
  "/feed",
  express.raw({ type: "multipart/form-data", limit: "12mb" }),
  wrap(async (req, res) => {
    ensureSchema();
    try {
      const { body, file } = await readFeed(req);
      const parsed = feedInputSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({ error: zodMessage(parsed.error) });
        return;
      }
      const clientId = parseClientId(parsed.data.client_id);
      const fileLines: FamiliarityInputLine[] = file ? (await parseFamiliarityFile(file)).lines : [];
      const lines = [...(parsed.data.raw_lines ?? []), ...fileLines];
      if (!lines.length) {
        res.status(400).json({ error: "Isi raw_lines atau unggah file Excel/CSV." });
        return;
      }
      const source = file && parsed.data.raw_lines?.length ? "mixed" : file ? "file" : "text";
      const view = await createFamiliaritySession(
        store,
        { clientId, title: parsed.data.title ?? "", source, lines },
        req.user!,
      );
      audit(req.user!.id, "familiarity", view.session_id, "feed", { client_id: clientId, rows: view.summary.total, source });
      res.json({ session_id: view.session_id, summary: view.summary, rows: view.rows });
    } catch (err) {
      fail(res, err);
    }
  }),
);

familiarityRouter.get(
  "/sessions/:sessionId",
  wrap(async (req, res) => {
    ensureSchema();
    const id = Number(req.params.sessionId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: "Sesi familiarity tidak ditemukan." });
      return;
    }
    const view = await readFamiliaritySession(store, id);
    if (!view) {
      res.status(404).json({ error: "Sesi familiarity tidak ditemukan." });
      return;
    }
    res.json({ session_id: view.session_id, summary: view.summary, rows: view.rows });
  }),
);

familiarityRouter.patch(
  "/sessions/:sessionId/resolve",
  wrap(async (req: AuthedRequest, res) => {
    ensureSchema();
    const id = Number(req.params.sessionId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: "Sesi familiarity tidak ditemukan." });
      return;
    }
    const parsed = resolveInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: zodMessage(parsed.error) });
      return;
    }
    try {
      const result = await resolveFamiliarityRow(store, id, parsed.data, req.user!);
      audit(req.user!.id, "familiarity", id, "resolve", {
        row_id: parsed.data.row_id,
        action: parsed.data.action,
        updated: result.rows.length,
      });
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  }),
);
