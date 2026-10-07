import { Hono } from "hono";
import { z } from "zod";
import { all, get, run, stmt, batch } from "../../db.d1";
import { audit, auditFor } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { hasPermission } from "../../../shared/permissions";
import { salesReviewSchema, snapshotSchema, unmatchedSchema, zodMessage } from "../../validate";
import { checkSalesReview, followsSalesRejection, rejectionNote, salesOutcome } from "../../../shared/salesReview";
import { tasksFromItems, tasksFromSalesRejection, tasksFromUnmatched, type NewFixTask } from "../../../shared/fixTasks";
import { INSERT_TASKS_SQL, insertTasksParams } from "../../fixTasks";
import {
  EDITABLE_STATUSES,
  STATUS_FLOW,
  breachesFor,
  catalogListsByKeys,
  cogsProblemsFor,
  findQuote,
  listQuoteRows,
  nextQuoteNumber,
  quoteMetrics,
  saveRevision,
} from "../quoteService";
import { isWithinPolicy } from "../../../shared/policy";
import { defaultPayment, missingTerms, missingTermsMessage } from "../../../shared/terms";
import { ALL_HELD, applyHolds, recostCodes } from "../../cogsCheck";
import {
  approvalsForViewer,
  auditForViewer,
  breachesForViewer,
  canSeeCosts,
  mergeStaffItems,
  policyForViewer,
  previewInput,
  problemsForViewer,
  quoteForViewer,
  quoteRowForViewer,
  staffSnapshotSchema,
} from "../../staffView";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS } from "../../../shared/engine";
import {
  notifyQuoteDecided,
  notifyQuoteReassigned,
  notifyQuoteReassignedAway,
  notifyQuoteSubmitted,
} from "../notify";
import type { Client, Quote, QuoteSnapshot, QuoteStatus, Role, User } from "../../../shared/types";
import type { Env } from "../env";

export const quotesRouter = new Hono<Env>();
quotesRouter.use(requireAuth);

/** Every quote this router sends goes through here: staff get prices, not costs (PE-1). */
const view = (role: Role, quote: Quote | null) => quote && quoteForViewer(role, quote);

/** "Perlu diperbaiki": one open task per problem (server/fixTasks.ts), as batch statements. */
const taskStmts = (db: D1Database, tasks: NewFixTask[], userId: number) =>
  insertTasksParams(tasks, userId).map((params) => stmt(db, INSERT_TASKS_SQL, ...params));

/** Reps may only change their own quotes or one reassigned to them; managers/admins may change any. */
function canEdit(user: User, createdBy: number, assignedTo: number | null): boolean {
  return user.id === createdBy || user.id === assignedTo || hasPermission(user.role, "edit_all_quotes");
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

quotesRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const status = (c.req.query("status") ?? "").trim();
  const mine = c.req.query("mine") === "1";
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status && status !== "all") {
    where.push("q.status = ?");
    params.push(status);
  }
  if (mine) {
    // Includes quotes reassigned TO this user, not just ones they created —
    // otherwise a reassigned quote silently drops out of the assignee's own list.
    where.push("(q.created_by = ? OR q.assigned_to = ?)");
    params.push(user.id, user.id);
  }
  const userIdParam = (c.req.query("user_id") ?? "").trim();
  if (userIdParam) {
    const uid = Number(userIdParam);
    if (Number.isFinite(uid)) {
      where.push("q.created_by = ?");
      params.push(uid);
    }
  }
  const quotes = await listQuoteRows(c.env.DB, where.length ? `WHERE ${where.join(" AND ")}` : "", ...params);
  return c.json({
    quotes: quotes.map((q) => {
      const { monthly_value, net_margin } = quoteMetrics(q);
      return {
        id: q.id,
        number: q.number,
        title: q.title,
        client_name: q.client_name ?? null,
        status: q.status,
        scenario: q.scenario,
        rev_no: q.rev_no,
        created_by_name: q.created_by_name ?? "",
        updated_at: q.updated_at,
        item_count: q.items.length,
        monthly_value,
        net_margin,
      };
    }).map((row) => quoteRowForViewer(c.get("user")!.role, row)),
  });
});

/** Users a manager/admin can reassign a quote to (for the "responsible person is absent" flow). */
quotesRouter.get("/users/assignable", requirePermission("decide_quotes"), async (c) => {
  const users = await all<Pick<User, "id" | "name" | "role">>(
    c.env.DB,
    "SELECT id, name, role FROM users WHERE active = 1 ORDER BY name",
  );
  return c.json({ users });
});

/**
 * Prices for lines a rep is editing, without saving: no version bump, no
 * audit entry. Lines merge onto the stored quote (or a new quote's defaults)
 * exactly as a save would, and the answer goes through quoteForViewer.
 */
quotesRouter.post("/preview", async (c) => {
  const user = c.get("user")!;
  const parsed = previewInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const base = parsed.data.quote_id ? await findQuote(c.env.DB, parsed.data.quote_id) : null;
  if (parsed.data.quote_id && !base) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  const stored = base?.items ?? [];
  const lines = parsed.data.snapshot.items;
  const catalog = await catalogListsByKeys(c.env.DB, [...stored.map((i) => i.code), ...lines.map((l) => l.code)]);
  const merged = mergeStaffItems(stored, lines, catalog, base?.scenario);
  if ("error" in merged) return c.json(merged, 400);
  const draft = {
    ...(base ?? { id: 0, number: "", title: "", status: "draft", rev_no: 1, version: 0 }),
    assumptions: base?.assumptions ?? DEFAULT_ASSUMPTIONS,
    regions: base?.regions ?? DEFAULT_REGIONS,
    scenario: base?.scenario ?? 1,
    meta: parsed.data.snapshot.meta ?? base?.meta,
    items: merged.items,
    status: "draft",
  } as Quote;
  const problems = await cogsProblemsFor(c.env.DB, merged.items.map((i) => i.code));
  const held = applyHolds(draft, problems, await catalogListsByKeys(c.env.DB, recostCodes([draft], problems)));
  return c.json({ quote: view(user.role, held) });
});

quotesRouter.get("/:id", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);

  const revisions = await all(
    c.env.DB,
    `SELECT r.id, r.rev_no, r.note, r.created_at, u.name AS created_by_name
       FROM quote_revisions r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.quote_id = ? ORDER BY r.id DESC`,
    id,
  );
  const approvalRows = await all<any>(
    c.env.DB,
    `SELECT a.id, a.decision, a.note, a.requested_at, a.decided_at, a.breaches,
            a.monthly_value, a.net_margin,
            ru.name AS requested_by_name, du.name AS decided_by_name
       FROM approvals a
       LEFT JOIN users ru ON ru.id = a.requested_by
       LEFT JOIN users du ON du.id = a.decided_by
      WHERE a.quote_id = ? ORDER BY a.id DESC`,
    id,
  );
  const approvals = approvalRows.map((a) => ({ ...a, breaches: JSON.parse(a.breaches || "[]") }));

  return c.json({
    quote: quoteForViewer(user.role, quote),
    revisions,
    approvals: approvalsForViewer(user.role, approvals),
    audit: auditForViewer(user.role, await auditFor(c.env.DB, "quote", id, 60)),
    policy: policyForViewer(user.role, await breachesFor(c.env.DB, quote)),
    canEdit: canEdit(user, quote.created_by, quote.assigned_to) && EDITABLE_STATUSES.includes(quote.status),
  });
});

quotesRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const parsed = z
    .object({
      title: z.string().min(1).max(200),
      client_id: z.number().int().nullable().optional(),
      snapshot: z.unknown().optional(),
      // Rows of a client's list with no catalog item ("Dari list klien"): kept as tasks.
      unmatched: unmatchedSchema.optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  // Staff send lines by catalog code; cost inputs come from the catalog and
  // defaults, never from the browser (PE-1).
  let requested: Partial<QuoteSnapshot> = {};
  if (parsed.data.snapshot !== undefined) {
    if (canSeeCosts(user.role)) {
      const full = snapshotSchema.partial().safeParse(parsed.data.snapshot);
      if (!full.success) return c.json({ error: zodMessage(full.error) }, 400);
      requested = full.data as Partial<QuoteSnapshot>;
    } else {
      const staff = staffSnapshotSchema.partial().safeParse(parsed.data.snapshot);
      if (!staff.success) return c.json({ error: zodMessage(staff.error) }, 400);
      const lines = staff.data.items ?? [];
      const merged = mergeStaffItems([], lines, await catalogListsByKeys(c.env.DB, lines.map((l) => l.code)));
      if ("error" in merged) return c.json(merged, 400);
      requested = { items: merged.items, ...(staff.data.meta ? { meta: staff.data.meta } : {}) };
    }
  }

  const client = parsed.data.client_id
    ? await get<Client>(c.env.DB, "SELECT * FROM clients WHERE id = ?", parsed.data.client_id)
    : undefined;

  // nextQuoteNumber() reads then this insert writes, with an await in between —
  // two concurrent requests can read the same number before either inserts.
  // Retry with a fresh number if the UNIQUE constraint on quotes.number trips.
  let number = await nextQuoteNumber(c.env.DB);
  let id: number | undefined;
  let snapshot: QuoteSnapshot | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    snapshot = {
      assumptions: requested.assumptions ?? DEFAULT_ASSUMPTIONS,
      items: requested.items ?? [],
      regions: requested.regions ?? DEFAULT_REGIONS,
      scenario: requested.scenario ?? 1,
      meta: requested.meta ?? {
        quoteNo: number,
        date: new Date().toISOString().slice(0, 10),
        validity: 30,
        ...defaultPayment(client?.payment_terms),
        warrantyYears: null,
        delivery: client?.delivery_terms || "Franco Jakarta, jadwal mingguan",
        notes: "",
        preparedBy: user.name,
      },
    };
    try {
      const info = await run(
        c.env.DB,
        `INSERT INTO quotes(number, title, client_id, status, scenario, rev_no,
                            assumptions, items, regions, meta, created_by)
         VALUES(?, ?, ?, 'draft', ?, 1, ?, ?, ?, ?, ?)`,
        number,
        parsed.data.title,
        parsed.data.client_id ?? null,
        snapshot.scenario,
        JSON.stringify(snapshot.assumptions),
        JSON.stringify(snapshot.items),
        JSON.stringify(snapshot.regions),
        JSON.stringify(snapshot.meta),
        user.id,
      );
      id = Number(info.meta.last_row_id);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 4 || !message.includes("UNIQUE constraint failed: quotes.number")) throw err;
      number = await nextQuoteNumber(c.env.DB);
    }
  }
  // The first revision and the list's missing rows go in one batch (one
  // transaction). The quote row itself is inserted just before (its number
  // may need a retry), so a failure here leaves a quote without them.
  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
      id!, 1, JSON.stringify(snapshot!), "Dibuat", user.id,
    ),
    ...taskStmts(c.env.DB, tasksFromUnmatched(id!, parsed.data.unmatched ?? []), user.id),
  ]);

  await audit(c.env.DB, user.id, "quote", id!, "created", { number, title: parsed.data.title });
  return c.json({ quote: view(user.role, await findQuote(c.env.DB, id!)) }, 201);
});

quotesRouter.put("/:id", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const existing = await findQuote(c.env.DB, id);
  if (!existing) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (!canEdit(user, existing.created_by, existing.assigned_to)) return c.json({ error: "Quotation ini milik pengguna lain." }, 403);
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    return c.json(
      { error: `Quotation berstatus ${existing.status} terkunci. Buka kembali sebagai revisi baru untuk mengubahnya.` },
      409,
    );
  }
  const parsed = z
    .object({
      title: z.string().min(1).max(200).optional(),
      client_id: z.number().int().nullable().optional(),
      snapshot: z.unknown(),
      expected_version: z.number().int(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);

  // Staff change qty, unit, ceiling, lines and terms; cost, role, manual
  // price, assumptions, regions and scenario stay as stored (PE-1).
  let s: QuoteSnapshot;
  if (canSeeCosts(user.role)) {
    const full = snapshotSchema.safeParse(parsed.data.snapshot);
    if (!full.success) return c.json({ error: zodMessage(full.error) }, 400);
    s = full.data as QuoteSnapshot;
  } else {
    const staff = staffSnapshotSchema.safeParse(parsed.data.snapshot);
    if (!staff.success) return c.json({ error: zodMessage(staff.error) }, 400);
    const codes = [...existing.items.map((it) => it.code), ...staff.data.items.map((l) => l.code)];
    const merged = mergeStaffItems(existing.items, staff.data.items, await catalogListsByKeys(c.env.DB, codes), existing.scenario);
    if ("error" in merged) return c.json(merged, 400);
    s = {
      assumptions: existing.assumptions,
      regions: existing.regions,
      scenario: existing.scenario,
      items: merged.items,
      meta: staff.data.meta ?? existing.meta,
    };
  }
  const result = await run(
    c.env.DB,
    `UPDATE quotes SET title = COALESCE(?, title), client_id = ?, scenario = ?,
            assumptions = ?, items = ?, regions = ?, meta = ?,
            version = version + 1, updated_at = datetime('now')
      WHERE id = ? AND version = ?`,
    parsed.data.title ?? null,
    parsed.data.client_id === undefined ? existing.client_id : parsed.data.client_id,
    s.scenario,
    JSON.stringify(s.assumptions),
    JSON.stringify(s.items),
    JSON.stringify(s.regions),
    JSON.stringify(s.meta),
    id,
    parsed.data.expected_version,
  );
  if (result.meta.changes === 0) {
    return c.json(
      {
        error: "Quotation ini sudah diubah pengguna lain. Muat ulang untuk melihat versi terbaru.",
        quote: view(user.role, await findQuote(c.env.DB, id)),
      },
      409,
    );
  }
  // Without this, an edit to a rejected quote (e.g. a manager fixing it
  // themselves before handing it back) left no trace anyone could see.
  await audit(c.env.DB, user.id, "quote", id, "edited", {
    version: parsed.data.expected_version + 1,
    from_status: existing.status,
  });
  return c.json({ quote: view(c.get("user")!.role, await findQuote(c.env.DB, id)) });
});

/** Explicit named snapshot, so a rep can bookmark a version before experimenting. */
quotesRouter.post("/:id/revisions", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (!canEdit(user, quote.created_by, quote.assigned_to)) {
    return c.json({ error: "Quotation ini milik pengguna lain." }, 403);
  }
  if (!EDITABLE_STATUSES.includes(quote.status)) {
    return c.json(
      { error: `Quotation berstatus ${quote.status} terkunci. Buka kembali sebagai revisi baru untuk mengubahnya.` },
      409,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const note = String(body?.note ?? "Snapshot manual").slice(0, 200);
  const snapshotJson = JSON.stringify(quote);
  const hasEditAll = hasPermission(user.role, "edit_all_quotes") ? 1 : 0;

  // Enforce the same checks atomically at the database — a concurrent
  // reassignment or status change between the read above and this write
  // must not allow a revision to slip through. A conditional INSERT that
  // re-checks status/ownership inside the statement guarantees the write
  // only succeeds if the quote is still in an editable state for this user.
  const result = await run(
    c.env.DB,
    `INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by)
     SELECT ?, ?, ?, ?, ? WHERE EXISTS (
       SELECT 1 FROM quotes
       WHERE id = ? AND status IN ('draft', 'rejected')
         AND (created_by = ? OR assigned_to = ? OR ? = 1)
     )`,
    id,
    quote.rev_no,
    snapshotJson,
    note,
    user.id,
    id,
    user.id,
    user.id,
    hasEditAll,
  );

  if (result.meta.changes === 0) {
    // The conditional insert affected 0 rows — the quote was concurrently
    // locked or reassigned. Re-read to return the precise 403/409.
    const fresh = await findQuote(c.env.DB, id);
    if (!fresh) return c.json({ error: "Quotation tidak ditemukan." }, 404);
    if (!canEdit(user, fresh.created_by, fresh.assigned_to)) {
      return c.json({ error: "Quotation ini milik pengguna lain." }, 403);
    }
    return c.json(
      { error: `Quotation berstatus ${fresh.status} terkunci. Buka kembali sebagai revisi baru untuk mengubahnya.` },
      409,
    );
  }

  await audit(c.env.DB, user.id, "quote", id, "revision_saved", { note });
  return c.json({ ok: true }, 201);
});

quotesRouter.post("/:id/restore/:revisionId", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (!canEdit(user, quote.created_by, quote.assigned_to) || !EDITABLE_STATUSES.includes(quote.status)) {
    return c.json({ error: "Quotation harus berstatus draft untuk dipulihkan." }, 409);
  }
  const rev = await get<{ snapshot: string; rev_no: number }>(
    c.env.DB,
    "SELECT snapshot, rev_no FROM quote_revisions WHERE id = ? AND quote_id = ?",
    Number(c.req.param("revisionId")),
    id,
  );
  if (!rev) return c.json({ error: "Revisi tidak ditemukan." }, 404);

  const s = JSON.parse(rev.snapshot) as QuoteSnapshot;
  const client = quote.client_id
    ? await get<{ code: string }>(c.env.DB, "SELECT code FROM clients WHERE id = ?", quote.client_id)
    : undefined;
  const restoreNo = quote.restore_count + 1;
  const tag = `restore-${slugify(client?.code || quote.client_name || "unassigned") || "unassigned"}-${restoreNo}`;

  await batch(c.env.DB, [
    // Snapshot what was there before the overwrite, so an accidental restore
    // doesn't silently discard unsaved draft content with no way back.
    stmt(
      c.env.DB,
      "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
      id,
      quote.rev_no,
      JSON.stringify(quote),
      `Sebelum ${tag}`,
      user.id,
    ),
    stmt(
      c.env.DB,
      `UPDATE quotes SET scenario = ?, assumptions = ?, items = ?, regions = ?, meta = ?,
              version = version + 1, restore_count = ?, updated_at = datetime('now') WHERE id = ?`,
      s.scenario ?? quote.scenario,
      JSON.stringify(s.assumptions),
      JSON.stringify(s.items),
      JSON.stringify(s.regions),
      JSON.stringify(s.meta),
      restoreNo,
      id,
    ),
    stmt(
      c.env.DB,
      "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
      id,
      quote.rev_no,
      JSON.stringify(s),
      tag,
      user.id,
    ),
  ]);
  await audit(c.env.DB, user.id, "quote", id, "restored", { from_rev: rev.rev_no, tag });
  return c.json({ quote: view(c.get("user")!.role, await findQuote(c.env.DB, id)) });
});

/** Hand a quote to another active user — manager/admin only, e.g. when the
 * responsible person is absent. Grants the new assignee edit rights alongside
 * (not instead of) the original creator. */
quotesRouter.post("/:id/reassign", requirePermission("decide_quotes"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);

  const parsed = z
    .object({ assigned_to: z.number().int().nullable(), note: z.string().max(500).default("") })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);

  if (parsed.data.assigned_to === quote.assigned_to) {
    // No actual change (e.g. re-picking the current assignee) — skip the
    // history entry and notifications so they aren't sent for nothing.
    return c.json({ quote: view(c.get("user")!.role, quote) });
  }
  let target: User | undefined;
  if (parsed.data.assigned_to !== null) {
    target = await get<User>(c.env.DB, "SELECT * FROM users WHERE id = ? AND active = 1", parsed.data.assigned_to);
    if (!target) return c.json({ error: "Pengguna tujuan tidak ditemukan atau tidak aktif." }, 400);
  }
  // Whoever was responsible before this change — the previous assignee, or
  // the creator if no one had been assigned yet — so they're told the quote
  // moved off their plate, not just the person receiving it.
  const previousOwnerId = quote.assigned_to ?? quote.created_by;
  const previousOwner =
    previousOwnerId !== user.id && previousOwnerId !== target?.id
      ? await get<User>(c.env.DB, "SELECT * FROM users WHERE id = ?", previousOwnerId)
      : undefined;

  const historyNote = target
    ? `Dialihkan ke ${target.name}${parsed.data.note ? `: ${parsed.data.note}` : ""}`
    : `Penugasan dilepas${parsed.data.note ? `: ${parsed.data.note}` : ""}`;

  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      "UPDATE quotes SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?",
      parsed.data.assigned_to,
      id,
    ),
    stmt(
      c.env.DB,
      "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
      id,
      quote.rev_no,
      JSON.stringify(quote),
      historyNote,
      user.id,
    ),
  ]);
  await audit(c.env.DB, user.id, "quote", id, "reassigned", { to: parsed.data.assigned_to, note: parsed.data.note });

  if (target) {
    c.executionCtx.waitUntil(
      notifyQuoteReassigned(c.env, {
        recipient: { name: target.name, email: target.email, phone: target.phone },
        quoteNumber: quote.number,
        quoteTitle: quote.title,
        reassignedBy: user.name,
        note: parsed.data.note,
        quoteId: id,
      }),
    );
  }
  if (previousOwner) {
    c.executionCtx.waitUntil(
      notifyQuoteReassignedAway(c.env, {
        recipient: { name: previousOwner.name, email: previousOwner.email, phone: previousOwner.phone },
        quoteNumber: quote.number,
        quoteTitle: quote.title,
        reassignedBy: user.name,
        newOwnerName: target?.name ?? null,
        note: parsed.data.note,
        quoteId: id,
      }),
    );
  }
  return c.json({ quote: view(c.get("user")!.role, await findQuote(c.env.DB, id)) });
});

/* ---------------- approval workflow ---------------- */

quotesRouter.post("/:id/submit", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (!canEdit(user, quote.created_by, quote.assigned_to)) return c.json({ error: "Quotation ini milik pengguna lain." }, 403);
  if (!EDITABLE_STATUSES.includes(quote.status)) return c.json({ error: "Hanya draft yang bisa diajukan." }, 409);
  // Term of payment and warranty must be on the customer's document.
  const missing = missingTerms(quote.meta);
  if (missing.length) return c.json({ error: missingTermsMessage(missing), missing }, 400);
  // Lines whose catalog COGS needs a manager are held, not offered (findQuote
  // applied the holds); the rest goes ahead. Nothing to offer -> refuse.
  if (quote.items.length && quote.items.every((it) => it.held)) return c.json({ error: ALL_HELD }, 400);

  const { breaches, monthly_value, net_margin } = await breachesFor(c.env.DB, quote);
  const clean = isWithinPolicy(breaches);
  // A manager submitting a quote that breaks no rule is approved on the spot,
  // except a revision that follows a sales Tolak: that one is decided explicitly.
  const afterSalesRejection = followsSalesRejection(
    await get<{ rev_no: number; rejected: number }>(
      c.env.DB,
      "SELECT rev_no, rejected FROM sales_reviews WHERE quote_id = ? AND rejected > 0 ORDER BY id DESC LIMIT 1",
      id,
    ),
    quote.rev_no,
  );
  const autoApprove = clean && !afterSalesRejection && hasPermission(user.role, "decide_quotes");
  const now = new Date().toISOString();
  // What isn't offered (held COGS, a unit without a ratio) goes on "Perlu diperbaiki".
  const heldProblems = await cogsProblemsFor(c.env.DB, quote.items.filter((it) => it.held).map((it) => it.code));

  await batch(c.env.DB, [
    ...taskStmts(c.env.DB, tasksFromItems(id, quote.items, heldProblems), user.id),
    stmt(
      c.env.DB,
      `INSERT INTO approvals(quote_id, requested_by, decision, breaches, monthly_value, net_margin,
                             decided_by, decided_at, note)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      autoApprove ? "approved" : "pending",
      JSON.stringify(breaches),
      monthly_value,
      net_margin,
      autoApprove ? user.id : null,
      autoApprove ? now : null,
      autoApprove ? "Otomatis disetujui: seluruh angka di dalam kebijakan." : null,
    ),
    // Freeze the holds as submitted: from here on the document doesn't change by itself.
    stmt(c.env.DB, "UPDATE quotes SET items = ? WHERE id = ?", JSON.stringify(quote.items), id),
    stmt(
      c.env.DB,
      `UPDATE quotes SET status = ?, approved_by = ?, approved_at = ?, updated_at = datetime('now')
        WHERE id = ?`,
      autoApprove ? "approved" : "submitted",
      autoApprove ? user.id : null,
      autoApprove ? now : null,
      id,
    ),
    stmt(
      c.env.DB,
      "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
      id,
      quote.rev_no,
      JSON.stringify(quote),
      autoApprove ? "Disetujui" : "Diajukan",
      user.id,
    ),
  ]);

  await audit(c.env.DB, user.id, "quote", id, autoApprove ? "auto_approved" : "submitted", {
    ...(afterSalesRejection && { after_sales_rejection: true }),
    breaches: breaches.map((b) => b.code),
    monthly_value,
    net_margin,
  });

  if (!autoApprove) {
    // Only the actual decision-maker (manager) gets the "needs your action"
    // email — admin still has decide_quotes for coverage/escalation, but
    // routing this to every admin as well just spams the people who are
    // meant to be monitoring, not approving on every quote.
    const recipients = await all<{ name: string; email: string; phone: string }>(
      c.env.DB,
      `SELECT name, email, phone FROM users WHERE role = 'manager' AND active = 1`,
    );
    // waitUntil: the response below returns before this settles, and Workers
    // don't keep running background work past that point unless extended.
    c.executionCtx.waitUntil(
      notifyQuoteSubmitted(c.env, {
        recipients,
        quoteNumber: quote.number,
        quoteTitle: quote.title,
        submittedBy: user.name,
        quoteId: id,
      }),
    );
  }

  return c.json({ quote: view(user.role, await findQuote(c.env.DB, id)), breaches: breachesForViewer(user.role, breaches), autoApproved: autoApprove });
});

quotesRouter.post("/:id/decide", requirePermission("decide_quotes"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (quote.status !== "submitted") return c.json({ error: "Quotation ini tidak sedang menunggu persetujuan." }, 409);

  const parsed = z
    .object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).default("") })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  // A rejection must say why, so the rep knows what to change.
  if (parsed.data.decision === "rejected" && !parsed.data.note.trim()) {
    return c.json({ error: "Penolakan wajib disertai alasan." }, 400);
  }
  const pending = await get<{ id: number }>(
    c.env.DB,
    "SELECT id FROM approvals WHERE quote_id = ? AND decision = 'pending' ORDER BY id DESC LIMIT 1",
    id,
  );
  const now = new Date().toISOString();

  const statements = [];
  if (pending) {
    statements.push(
      stmt(
        c.env.DB,
        "UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?",
        parsed.data.decision,
        user.id,
        now,
        parsed.data.note,
        pending.id,
      ),
    );
  }
  statements.push(
    stmt(
      c.env.DB,
      // approved_by/approved_at record whoever decided, approve or reject —
      // otherwise a rejection banner has no way to say who rejected it.
      `UPDATE quotes SET status = ?, approved_by = ?, approved_at = ?, decision_note = ?,
              updated_at = datetime('now') WHERE id = ?`,
      parsed.data.decision,
      user.id,
      now,
      parsed.data.note,
      id,
    ),
    stmt(
      c.env.DB,
      "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
      id,
      quote.rev_no,
      JSON.stringify(quote),
      parsed.data.decision === "approved" ? "Disetujui" : "Ditolak",
      user.id,
    ),
  );
  await batch(c.env.DB, statements);

  await audit(c.env.DB, user.id, "quote", id, parsed.data.decision, { note: parsed.data.note });

  const submitter = await get<{ name: string; email: string; phone: string }>(
    c.env.DB,
    "SELECT name, email, phone FROM users WHERE id = ?",
    quote.created_by,
  );
  if (submitter) {
    c.executionCtx.waitUntil(
      notifyQuoteDecided(c.env, {
        recipient: submitter,
        quoteNumber: quote.number,
        quoteTitle: quote.title,
        decision: parsed.data.decision,
        decidedBy: user.name,
        note: parsed.data.note,
        quoteId: id,
      }),
    );
  }

  return c.json({ quote: view(c.get("user")!.role, await findQuote(c.env.DB, id)) });
});

quotesRouter.post("/:id/status", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (!canEdit(user, quote.created_by, quote.assigned_to)) return c.json({ error: "Quotation ini milik pengguna lain." }, 403);

  const body = await c.req.json().catch(() => ({}));
  const next = String(body?.status ?? "") as QuoteStatus;
  const allowed = STATUS_FLOW[quote.status] ?? [];
  if (!allowed.includes(next)) {
    return c.json({ error: `Status ${quote.status} tidak bisa langsung menjadi ${next}.` }, 409);
  }
  await run(c.env.DB, "UPDATE quotes SET status = ?, updated_at = datetime('now') WHERE id = ?", next, id);
  await audit(c.env.DB, user.id, "quote", id, `status_${next}`);
  return c.json({ quote: view(c.get("user")!.role, await findQuote(c.env.DB, id)) });
});

/** Unlocks a decided quote as a new revision, preserving the approved history. */
quotesRouter.post("/:id/reopen", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (!canEdit(user, quote.created_by, quote.assigned_to)) return c.json({ error: "Quotation ini milik pengguna lain." }, 403);
  if (quote.status === "draft") return c.json({ error: "Quotation sudah berstatus draft." }, 409);

  const nextRev = quote.rev_no + 1;
  const statements = [
    stmt(
      c.env.DB,
      "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
      id,
      quote.rev_no,
      JSON.stringify(quote),
      `Ditutup sebagai revisi ${quote.rev_no}`,
      user.id,
    ),
    stmt(
      c.env.DB,
      `UPDATE quotes SET status = 'draft', rev_no = ?, approved_by = NULL, approved_at = NULL,
              decision_note = NULL, updated_at = datetime('now') WHERE id = ?`,
      nextRev,
      id,
    ),
  ];
  if (quote.status === "submitted") {
    // Reopening a quote that's still awaiting a decision voids that
    // request — otherwise it lingers forever in the manager's pending
    // queue, pointing at content that's already back in draft.
    statements.push(stmt(c.env.DB, "DELETE FROM approvals WHERE quote_id = ? AND decision = 'pending'", id));
  }
  await batch(c.env.DB, statements);
  await audit(c.env.DB, user.id, "quote", id, "reopened", { rev_no: nextRev });
  return c.json({ quote: view(c.get("user")!.role, await findQuote(c.env.DB, id)) });
});

/* ---------------- PE-2: sales check the locked "Cek harga" Excel ---------------- */

async function latestSalesReview(db: D1Database, id: number) {
  const r = await get<{ lines: string } & Record<string, unknown>>(
    db,
    `SELECT s.id, s.rev_no, s.lines, s.rejected, s.created_at, u.name AS reviewed_by_name
       FROM sales_reviews s LEFT JOIN users u ON u.id = s.reviewed_by
      WHERE s.quote_id = ? ORDER BY s.id DESC LIMIT 1`,
    id,
  );
  return r ? { ...r, lines: JSON.parse(r.lines) } : null;
}

quotesRouter.get("/:id/sales-review", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await get(c.env.DB, "SELECT id FROM quotes WHERE id = ?", id))) {
    return c.json({ error: "Quotation tidak ditemukan." }, 404);
  }
  return c.json({ review: await latestSalesReview(c.env.DB, id) });
});

/**
 * All ACC: recorded, the quote stays approved. Some Tolak: those lines are
 * held as "sales" and become "Perlu diperbaiki" tasks; the rest stays
 * approved (or goes to the manager if it now breaks the policy). Every line
 * Tolak: back to draft as the next revision for the manager.
 */
quotesRouter.post("/:id/sales-review", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);
  if (!canEdit(user, quote.created_by, quote.assigned_to)) return c.json({ error: "Quotation ini milik pengguna lain." }, 403);
  const parsed = salesReviewSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const check = checkSalesReview(quote, parsed.data);
  if (!check.ok) return c.json({ error: check.error }, check.status);

  const rejected = check.rejected.length;
  const outcome = salesOutcome(quote.items, check.rejected);
  // A partial rejection changes what the client is offered; if what is left
  // breaks the policy, the manager decides again (pending) instead of the
  // quote staying approved on numbers nobody approved.
  const after = { ...quote, items: outcome.items };
  const recheck = outcome.mode === "partial" ? await breachesFor(c.env.DB, after) : null;
  const backToManager = !!recheck && !isWithinPolicy(recheck.breaches);
  const db = c.env.DB;
  const statements = [
    stmt(
      db,
      "INSERT INTO sales_reviews(quote_id, rev_no, reviewed_by, lines, rejected) VALUES(?, ?, ?, ?, ?)",
      id, quote.rev_no, user.id, JSON.stringify(check.lines), rejected,
    ),
    ...taskStmts(db, tasksFromSalesRejection(id, check.rejected, quote.items, user.name), user.id),
  ];
  if (outcome.mode === "all") {
    // Nothing left to offer: back to draft for the manager, like a reopen.
    statements.push(
      stmt(
        db,
        "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
        id, quote.rev_no, JSON.stringify(quote), `Ditolak sales: semua ${rejected} baris`, user.id,
      ),
      stmt(
        db,
        `UPDATE quotes SET status = 'draft', rev_no = ?, approved_by = NULL, approved_at = NULL,
                decision_note = NULL, updated_at = datetime('now') WHERE id = ?`,
        quote.rev_no + 1, id,
      ),
    );
  } else if (outcome.mode === "partial") {
    // The version moves so an older "Cek harga" file can't be imported again.
    statements.push(
      stmt(db, "UPDATE quotes SET items = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?", JSON.stringify(outcome.items), id),
      stmt(
        db,
        "INSERT INTO quote_revisions(quote_id, rev_no, snapshot, note, created_by) VALUES(?, ?, ?, ?, ?)",
        id, quote.rev_no, JSON.stringify(after), `Dicek sales: ${rejected} baris menyusul`, user.id,
      ),
    );
    if (backToManager) {
      statements.push(
        stmt(
          db,
          `INSERT INTO approvals(quote_id, requested_by, decision, breaches, monthly_value, net_margin)
           VALUES(?, ?, 'pending', ?, ?, ?)`,
          id, user.id, JSON.stringify(recheck!.breaches), recheck!.monthly_value, recheck!.net_margin,
        ),
        stmt(db, "UPDATE quotes SET status = 'submitted', approved_by = NULL, approved_at = NULL, updated_at = datetime('now') WHERE id = ?", id),
      );
    }
  }
  await batch(db, statements);
  await audit(db, user.id, "quote", id, rejected ? "sales_rejected" : "sales_accepted", {
    rev_no: quote.rev_no,
    rejected: check.rejected.map((l) => l.lineNo),
    outcome: backToManager ? "pending" : outcome.mode,
  });
  if (outcome.mode === "all" || backToManager) {
    const managers = await all<{ name: string; email: string; phone: string }>(
      db,
      "SELECT name, email, phone FROM users WHERE role = 'manager' AND active = 1",
    );
    const note = rejectionNote(user.name, check.rejected);
    c.executionCtx.waitUntil(
      outcome.mode === "all"
        ? Promise.all(
            managers.map((recipient) =>
              notifyQuoteDecided(c.env, {
                recipient, quoteNumber: quote.number, quoteTitle: quote.title, decision: "rejected",
                decidedBy: `${user.name} (cek sales)`, note, quoteId: id,
              }),
            ),
          )
        : notifyQuoteSubmitted(c.env, {
            recipients: managers, quoteNumber: quote.number, quoteTitle: quote.title,
            submittedBy: `${user.name} (cek sales: ${rejected} baris menyusul)`, quoteId: id,
          }),
    );
  }
  return c.json({ quote: view(user.role, await findQuote(c.env.DB, id)), review: await latestSalesReview(c.env.DB, id) });
});

quotesRouter.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const quote = await findQuote(c.env.DB, id);
  if (!quote) return c.json({ error: "Quotation tidak ditemukan." }, 404);

  const isOwnDraft = quote.created_by === user.id && quote.status === "draft";
  if (!isOwnDraft && !hasPermission(user.role, "delete_quotes")) {
    return c.json({ error: "Hanya draft milik sendiri yang bisa dihapus. Selain itu perlu admin." }, 403);
  }
  await run(c.env.DB, "DELETE FROM quotes WHERE id = ?", id);
  await audit(c.env.DB, user.id, "quote", id, "deleted", { number: quote.number });
  return c.json({ ok: true });
});
