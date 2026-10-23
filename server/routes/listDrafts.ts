import { Router, type NextFunction, type Request, type Response } from "express";
import { all, get, run } from "../db.js";
import { audit } from "../audit.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { notifyDraftAssigned } from "../notify.js";
import { zodMessage } from "../validate.js";
import {
  ASSIGNABLE_USERS_SQL,
  DraftError,
  cancelDraft,
  createDraft,
  draftInputSchema,
  getDraft,
  listDrafts,
  sendDraft,
  sendInputSchema,
  updateDraft,
  type DraftStore,
} from "../listDrafts.js";

/* Drafts of "Dari list klien": the HTTP shell around server/listDrafts.ts.
   The Worker route is the twin; both call the same service. */

export const listDraftsRouter = Router();
listDraftsRouter.use(requireAuth);

export const draftStore: DraftStore = {
  all: async <T>(sql: string, ...params: (string | number | null)[]) => all<T>(sql, ...params) as T[],
  get: async <T>(sql: string, ...params: (string | number | null)[]) => get<T>(sql, ...params) as T | undefined,
  run: async (sql: string, ...params: (string | number | null)[]) => {
    const r = run(sql, ...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  },
};

type Handler = (req: AuthedRequest, res: Response) => Promise<void>;

/** Runs a handler; a DraftError becomes its status and sentence, anything else goes to Express. */
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req as AuthedRequest, res).catch((err) => {
      if (err instanceof DraftError) res.status(err.status).json({ error: err.message });
      else next(err);
    });
  };

const idOf = (req: Request) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

listDraftsRouter.get("/", wrap(async (req, res) => {
  res.json({ drafts: await listDrafts(draftStore, req.user!) });
}));

listDraftsRouter.get("/users", wrap(async (_req, res) => {
  res.json({ users: all(ASSIGNABLE_USERS_SQL) });
}));

listDraftsRouter.post("/", wrap(async (req, res) => {
  const parsed = draftInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  const draft = await createDraft(draftStore, req.user!, parsed.data);
  audit(req.user!.id, "list_draft", draft.id, "draft_saved", { rows: draft.rows, created: true });
  res.status(201).json({ draft });
}));

listDraftsRouter.get("/:id", wrap(async (req, res) => {
  const id = idOf(req);
  if (!id) {
    res.status(404).json({ error: "Draft tidak ditemukan." });
    return;
  }
  res.json({ draft: await getDraft(draftStore, req.user!, id) });
}));

listDraftsRouter.put("/:id", wrap(async (req, res) => {
  const id = idOf(req);
  if (!id) {
    res.status(404).json({ error: "Draft tidak ditemukan." });
    return;
  }
  const parsed = draftInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  res.json({ draft: await updateDraft(draftStore, req.user!, id, parsed.data) });
}));

listDraftsRouter.post("/:id/send", wrap(async (req, res) => {
  const id = idOf(req);
  if (!id) {
    res.status(404).json({ error: "Draft tidak ditemukan." });
    return;
  }
  const parsed = sendInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  const { draft, recipient } = await sendDraft(draftStore, req.user!, id, parsed.data);
  audit(req.user!.id, "list_draft", id, "draft_sent", { to: parsed.data.assigned_to, note: parsed.data.note });
  if (recipient) {
    void notifyDraftAssigned({ recipient, draftId: id, draftTitle: draft.title, rows: draft.rows, sentBy: req.user!.name, note: parsed.data.note });
  }
  res.json({ draft });
}));

listDraftsRouter.delete("/:id", wrap(async (req, res) => {
  const id = idOf(req);
  if (!id) {
    res.status(404).json({ error: "Draft tidak ditemukan." });
    return;
  }
  await cancelDraft(draftStore, req.user!, id);
  audit(req.user!.id, "list_draft", id, "draft_cancelled");
  res.json({ ok: true });
}));
