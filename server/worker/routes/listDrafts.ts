import { Hono } from "hono";
import { all, get, run } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth } from "../auth";
import { notifyDraftAssigned } from "../notify";
import { zodMessage } from "../../validate";
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
} from "../../listDrafts";
import type { Env } from "../env";

/* Drafts of "Dari list klien" on D1. The service (server/listDrafts.ts)
   decides; this file only adapts Hono/HTTP. */

export const listDraftsRouter = new Hono<Env>();
listDraftsRouter.use(requireAuth);

export function draftStore(db: D1Database): DraftStore {
  return {
    all: <T>(sql: string, ...params: (string | number | null)[]) => all<T>(db, sql, ...params),
    get: <T>(sql: string, ...params: (string | number | null)[]) => get<T>(db, sql, ...params),
    run: async (sql: string, ...params: (string | number | null)[]) => {
      const r = await run(db, sql, ...params);
      return { changes: Number(r.meta.changes), lastId: Number(r.meta.last_row_id) };
    },
  };
}

function fail(c: any, err: unknown) {
  if (err instanceof DraftError) return c.json({ error: err.message }, err.status as 400);
  throw err;
}

const idOf = (c: any) => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
};

listDraftsRouter.get("/", async (c) => {
  return c.json({ drafts: await listDrafts(draftStore(c.env.DB), c.get("user")!) });
});

listDraftsRouter.get("/users", async (c) => {
  return c.json({ users: await all(c.env.DB, ASSIGNABLE_USERS_SQL) });
});

listDraftsRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const parsed = draftInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  try {
    const draft = await createDraft(draftStore(c.env.DB), user, parsed.data);
    await audit(c.env.DB, user.id, "list_draft", draft.id, "draft_saved", { rows: draft.rows, created: true });
    return c.json({ draft }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

listDraftsRouter.get("/:id", async (c) => {
  const id = idOf(c);
  if (!id) return c.json({ error: "Draft tidak ditemukan." }, 404);
  try {
    return c.json({ draft: await getDraft(draftStore(c.env.DB), c.get("user")!, id) });
  } catch (err) {
    return fail(c, err);
  }
});

listDraftsRouter.put("/:id", async (c) => {
  const user = c.get("user")!;
  const id = idOf(c);
  if (!id) return c.json({ error: "Draft tidak ditemukan." }, 404);
  const parsed = draftInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  try {
    return c.json({ draft: await updateDraft(draftStore(c.env.DB), user, id, parsed.data) });
  } catch (err) {
    return fail(c, err);
  }
});

listDraftsRouter.post("/:id/send", async (c) => {
  const user = c.get("user")!;
  const id = idOf(c);
  if (!id) return c.json({ error: "Draft tidak ditemukan." }, 404);
  const parsed = sendInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  try {
    const { draft, recipient } = await sendDraft(draftStore(c.env.DB), user, id, parsed.data);
    await audit(c.env.DB, user.id, "list_draft", id, "draft_sent", { to: parsed.data.assigned_to, note: parsed.data.note });
    if (recipient) {
      c.executionCtx.waitUntil(
        notifyDraftAssigned(c.env, { recipient, draftId: id, draftTitle: draft.title, rows: draft.rows, sentBy: user.name, note: parsed.data.note }),
      );
    }
    return c.json({ draft });
  } catch (err) {
    return fail(c, err);
  }
});

listDraftsRouter.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const id = idOf(c);
  if (!id) return c.json({ error: "Draft tidak ditemukan." }, 404);
  try {
    await cancelDraft(draftStore(c.env.DB), user, id);
    await audit(c.env.DB, user.id, "list_draft", id, "draft_cancelled");
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});
