import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx } from "../db.js";
import { audit, auditFor } from "../audit.js";
import { type AuthedRequest, requireAuth, requirePermission } from "../auth.js";
import { hasPermission } from "../../shared/permissions.js";
import { salesReviewSchema, snapshotSchema, zodMessage } from "../validate.js";
import { checkSalesReview, rejectionNote } from "../../shared/salesReview.js";
import {
  EDITABLE_STATUSES,
  STATUS_FLOW,
  breachesFor,
  catalogByKeys,
  cogsProblemsFor,
  findQuote,
  listQuoteRows,
  nextQuoteNumber,
  quoteMetrics,
  saveRevision,
} from "../quoteService.js";
import { isWithinPolicy } from "../../shared/policy.js";
import { defaultPayment, missingTerms, missingTermsMessage } from "../../shared/terms.js";
import { ALL_HELD, applyHolds } from "../cogsCheck.js";
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
} from "../staffView.js";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS } from "../../shared/engine.js";
import {
  notifyQuoteDecided,
  notifyQuoteReassigned,
  notifyQuoteReassignedAway,
  notifyQuoteSubmitted,
} from "../notify.js";
import type { Client, Quote, QuoteSnapshot, QuoteStatus, User } from "../../shared/types.js";

export const quotesRouter = Router();
quotesRouter.use(requireAuth);

/** Every quote this router sends goes through here: staff get prices, not costs (PE-1). */
const view = (req: AuthedRequest, quote: Quote | null) => quote && quoteForViewer(req.user!.role, quote);

/** Reps may only change their own quotes or one reassigned to them; managers/admins may change any. */
function canEdit(req: AuthedRequest, createdBy: number, assignedTo: number | null): boolean {
  return (
    req.user!.id === createdBy ||
    req.user!.id === assignedTo ||
    hasPermission(req.user!.role, "edit_all_quotes")
  );
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

quotesRouter.get("/", (req: AuthedRequest, res) => {
  const status = String(req.query.status ?? "").trim();
  const mine = String(req.query.mine ?? "") === "1";
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
    params.push(req.user!.id, req.user!.id);
  }
  const userIdParam = String(req.query.user_id ?? "").trim();
  if (userIdParam) {
    const uid = Number(userIdParam);
    if (Number.isFinite(uid)) {
      where.push("q.created_by = ?");
      params.push(uid);
    }
  }
  const quotes = listQuoteRows(where.length ? `WHERE ${where.join(" AND ")}` : "", ...params);
  res.json({
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
    }).map((row) => quoteRowForViewer(req.user!.role, row)),
  });
});

/** Users a manager/admin can reassign a quote to (for the "responsible person is absent" flow). */
quotesRouter.get("/users/assignable", requirePermission("decide_quotes"), (_req: AuthedRequest, res) => {
  res.json({
    users: all<Pick<User, "id" | "name" | "role">>(
      "SELECT id, name, role FROM users WHERE active = 1 ORDER BY name",
    ),
  });
});

/**
 * Prices for lines a rep is editing, without saving: no version bump, no
 * audit entry. Lines merge onto the stored quote (or a new quote's defaults)
 * exactly as a save would, and the answer goes through quoteForViewer.
 */
quotesRouter.post("/preview", (req: AuthedRequest, res) => {
  const parsed = previewInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  const base = parsed.data.quote_id ? findQuote(parsed.data.quote_id) : null;
  if (parsed.data.quote_id && !base) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  const stored = base?.items ?? [];
  const lines = parsed.data.snapshot.items;
  const merged = mergeStaffItems(stored, lines, catalogByKeys([...stored.map((i) => i.code), ...lines.map((l) => l.code)]), base?.scenario);
  if ("error" in merged) {
    res.status(400).json(merged);
    return;
  }
  const draft = {
    ...(base ?? { id: 0, number: "", title: "", status: "draft", rev_no: 1, version: 0 }),
    assumptions: base?.assumptions ?? DEFAULT_ASSUMPTIONS,
    regions: base?.regions ?? DEFAULT_REGIONS,
    scenario: base?.scenario ?? 1,
    meta: parsed.data.snapshot.meta ?? base?.meta,
    items: merged.items,
    status: "draft",
  } as Quote;
  const held = applyHolds(draft, cogsProblemsFor(merged.items.map((i) => i.code)));
  res.json({ quote: view(req, held) });
});

quotesRouter.get("/:id", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  const revisions = all(
    `SELECT r.id, r.rev_no, r.note, r.created_at, u.name AS created_by_name
       FROM quote_revisions r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.quote_id = ? ORDER BY r.id DESC`,
    id,
  );
  const approvals = all(
    `SELECT a.id, a.decision, a.note, a.requested_at, a.decided_at, a.breaches,
            a.monthly_value, a.net_margin,
            ru.name AS requested_by_name, du.name AS decided_by_name
       FROM approvals a
       LEFT JOIN users ru ON ru.id = a.requested_by
       LEFT JOIN users du ON du.id = a.decided_by
      WHERE a.quote_id = ? ORDER BY a.id DESC`,
    id,
  ).map((a: any) => ({ ...a, breaches: JSON.parse(a.breaches || "[]") }));

  const role = req.user!.role;
  res.json({
    quote: quoteForViewer(role, quote),
    revisions,
    approvals: approvalsForViewer(role, approvals),
    audit: auditForViewer(role, auditFor("quote", id, 60)),
    policy: policyForViewer(role, breachesFor(quote)),
    canEdit: canEdit(req, quote.created_by, quote.assigned_to) && EDITABLE_STATUSES.includes(quote.status),
  });
});

quotesRouter.post("/", (req: AuthedRequest, res) => {
  const parsed = z
    .object({
      title: z.string().min(1).max(200),
      client_id: z.number().int().nullable().optional(),
      snapshot: z.unknown().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  // Staff send lines by catalog code; cost inputs come from the catalog and
  // defaults, never from the browser (PE-1).
  let requested: Partial<QuoteSnapshot> = {};
  if (parsed.data.snapshot !== undefined) {
    if (canSeeCosts(req.user!.role)) {
      const full = snapshotSchema.partial().safeParse(parsed.data.snapshot);
      if (!full.success) {
        res.status(400).json({ error: zodMessage(full.error) });
        return;
      }
      requested = full.data as Partial<QuoteSnapshot>;
    } else {
      const staff = staffSnapshotSchema.partial().safeParse(parsed.data.snapshot);
      if (!staff.success) {
        res.status(400).json({ error: zodMessage(staff.error) });
        return;
      }
      const lines = staff.data.items ?? [];
      const merged = mergeStaffItems([], lines, catalogByKeys(lines.map((l) => l.code)));
      if ("error" in merged) {
        res.status(400).json(merged);
        return;
      }
      requested = { items: merged.items, ...(staff.data.meta ? { meta: staff.data.meta } : {}) };
    }
  }
  const client = parsed.data.client_id
    ? get<Client>("SELECT * FROM clients WHERE id = ?", parsed.data.client_id)
    : undefined;

  // nextQuoteNumber() reads then this insert writes, not atomically — two
  // concurrent requests can read the same number before either inserts.
  // Retry with a fresh number if the UNIQUE constraint on quotes.number trips.
  let number = nextQuoteNumber();
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
        preparedBy: req.user!.name,
      },
    };
    try {
      id = tx(() => {
        const info = run(
          `INSERT INTO quotes(number, title, client_id, status, scenario, rev_no,
                              assumptions, items, regions, meta, created_by)
           VALUES(?, ?, ?, 'draft', ?, 1, ?, ?, ?, ?, ?)`,
          number,
          parsed.data.title,
          parsed.data.client_id ?? null,
          snapshot!.scenario,
          JSON.stringify(snapshot!.assumptions),
          JSON.stringify(snapshot!.items),
          JSON.stringify(snapshot!.regions),
          JSON.stringify(snapshot!.meta),
          req.user!.id,
        );
        const newId = Number(info.lastInsertRowid);
        saveRevision(newId, 1, snapshot!, req.user!.id, "Dibuat");
        return newId;
      });
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 4 || !message.includes("UNIQUE constraint failed: quotes.number")) throw err;
      number = nextQuoteNumber();
    }
  }

  audit(req.user!.id, "quote", id!, "created", { number, title: parsed.data.title });
  res.status(201).json({ quote: view(req, findQuote(id!)) });
});

quotesRouter.put("/:id", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = findQuote(id);
  if (!existing) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (!canEdit(req, existing.created_by, existing.assigned_to)) {
    res.status(403).json({ error: "Quotation ini milik pengguna lain." });
    return;
  }
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    res.status(409).json({
      error: `Quotation berstatus ${existing.status} terkunci. Buka kembali sebagai revisi baru untuk mengubahnya.`,
    });
    return;
  }
  const parsed = z
    .object({
      title: z.string().min(1).max(200).optional(),
      client_id: z.number().int().nullable().optional(),
      snapshot: z.unknown(),
      expected_version: z.number().int(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  // Staff change qty, unit, ceiling, lines and terms; cost, role, manual
  // price, assumptions, regions and scenario stay as stored (PE-1).
  let s: QuoteSnapshot;
  if (canSeeCosts(req.user!.role)) {
    const full = snapshotSchema.safeParse(parsed.data.snapshot);
    if (!full.success) {
      res.status(400).json({ error: zodMessage(full.error) });
      return;
    }
    s = full.data as QuoteSnapshot;
  } else {
    const staff = staffSnapshotSchema.safeParse(parsed.data.snapshot);
    if (!staff.success) {
      res.status(400).json({ error: zodMessage(staff.error) });
      return;
    }
    const codes = [...existing.items.map((it) => it.code), ...staff.data.items.map((l) => l.code)];
    const merged = mergeStaffItems(existing.items, staff.data.items, catalogByKeys(codes), existing.scenario);
    if ("error" in merged) {
      res.status(400).json(merged);
      return;
    }
    s = {
      assumptions: existing.assumptions,
      regions: existing.regions,
      scenario: existing.scenario,
      items: merged.items,
      meta: staff.data.meta ?? existing.meta,
    };
  }
  const info = run(
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
  if (info.changes === 0) {
    res.status(409).json({
      error: "Quotation ini sudah diubah pengguna lain. Muat ulang untuk melihat versi terbaru.",
      quote: view(req, findQuote(id)),
    });
    return;
  }
  // Without this, an edit to a rejected quote (e.g. a manager fixing it
  // themselves before handing it back) left no trace anyone could see.
  audit(req.user!.id, "quote", id, "edited", {
    version: parsed.data.expected_version + 1,
    from_status: existing.status,
  });
  res.json({ quote: view(req, findQuote(id)) });
});

/** Explicit named snapshot, so a rep can bookmark a version before experimenting. */
quotesRouter.post("/:id/revisions", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (!canEdit(req, quote.created_by, quote.assigned_to)) {
    res.status(403).json({ error: "Quotation ini milik pengguna lain." });
    return;
  }
  if (!EDITABLE_STATUSES.includes(quote.status)) {
    res.status(409).json({
      error: `Quotation berstatus ${quote.status} terkunci. Buka kembali sebagai revisi baru untuk mengubahnya.`,
    });
    return;
  }
  const note = String(req.body?.note ?? "Snapshot manual").slice(0, 200);
  saveRevision(id, quote.rev_no, quote, req.user!.id, note);
  audit(req.user!.id, "quote", id, "revision_saved", { note });
  res.status(201).json({ ok: true });
});

quotesRouter.post("/:id/restore/:revisionId", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (!canEdit(req, quote.created_by, quote.assigned_to) || !EDITABLE_STATUSES.includes(quote.status)) {
    res.status(409).json({ error: "Quotation harus berstatus draft untuk dipulihkan." });
    return;
  }
  const rev = get<{ snapshot: string; rev_no: number }>(
    "SELECT snapshot, rev_no FROM quote_revisions WHERE id = ? AND quote_id = ?",
    Number(req.params.revisionId),
    id,
  );
  if (!rev) {
    res.status(404).json({ error: "Revisi tidak ditemukan." });
    return;
  }
  const s = JSON.parse(rev.snapshot) as QuoteSnapshot;
  const client = quote.client_id
    ? get<{ code: string }>("SELECT code FROM clients WHERE id = ?", quote.client_id)
    : undefined;
  const restoreNo = quote.restore_count + 1;
  const tag = `restore-${slugify(client?.code || quote.client_name || "unassigned") || "unassigned"}-${restoreNo}`;

  tx(() => {
    // Snapshot what was there before the overwrite, so an accidental restore
    // doesn't silently discard unsaved draft content with no way back.
    saveRevision(id, quote.rev_no, quote, req.user!.id, `Sebelum ${tag}`);
    run(
      `UPDATE quotes SET scenario = ?, assumptions = ?, items = ?, regions = ?, meta = ?,
              version = version + 1, restore_count = ?, updated_at = datetime('now') WHERE id = ?`,
      s.scenario ?? quote.scenario,
      JSON.stringify(s.assumptions),
      JSON.stringify(s.items),
      JSON.stringify(s.regions),
      JSON.stringify(s.meta),
      restoreNo,
      id,
    );
    saveRevision(id, quote.rev_no, s, req.user!.id, tag);
  });
  audit(req.user!.id, "quote", id, "restored", { from_rev: rev.rev_no, tag });
  res.json({ quote: view(req, findQuote(id)) });
});

/** Hand a quote to another active user — manager/admin only, e.g. when the
 * responsible person is absent. Grants the new assignee edit rights alongside
 * (not instead of) the original creator. */
quotesRouter.post("/:id/reassign", requirePermission("decide_quotes"), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  const parsed = z
    .object({ assigned_to: z.number().int().nullable(), note: z.string().max(500).default("") })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  if (parsed.data.assigned_to === quote.assigned_to) {
    // No actual change (e.g. re-picking the current assignee) — skip the
    // history entry and notifications so they aren't sent for nothing.
    res.json({ quote: view(req, quote) });
    return;
  }
  let target: User | undefined;
  if (parsed.data.assigned_to !== null) {
    target = get<User>("SELECT * FROM users WHERE id = ? AND active = 1", parsed.data.assigned_to);
    if (!target) {
      res.status(400).json({ error: "Pengguna tujuan tidak ditemukan atau tidak aktif." });
      return;
    }
  }
  // Whoever was responsible before this change — the previous assignee, or
  // the creator if no one had been assigned yet — so they're told the quote
  // moved off their plate, not just the person receiving it.
  const previousOwnerId = quote.assigned_to ?? quote.created_by;
  const previousOwner =
    previousOwnerId !== req.user!.id && previousOwnerId !== target?.id
      ? get<User>("SELECT * FROM users WHERE id = ?", previousOwnerId)
      : undefined;

  const historyNote = target
    ? `Dialihkan ke ${target.name}${parsed.data.note ? `: ${parsed.data.note}` : ""}`
    : `Penugasan dilepas${parsed.data.note ? `: ${parsed.data.note}` : ""}`;

  tx(() => {
    run("UPDATE quotes SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?", parsed.data.assigned_to, id);
    saveRevision(id, quote.rev_no, quote, req.user!.id, historyNote);
  });
  audit(req.user!.id, "quote", id, "reassigned", { to: parsed.data.assigned_to, note: parsed.data.note });

  if (target) {
    void notifyQuoteReassigned({
      recipient: { name: target.name, email: target.email, phone: target.phone },
      quoteNumber: quote.number,
      quoteTitle: quote.title,
      reassignedBy: req.user!.name,
      note: parsed.data.note,
      quoteId: id,
    });
  }
  if (previousOwner) {
    void notifyQuoteReassignedAway({
      recipient: { name: previousOwner.name, email: previousOwner.email, phone: previousOwner.phone },
      quoteNumber: quote.number,
      quoteTitle: quote.title,
      reassignedBy: req.user!.name,
      newOwnerName: target?.name ?? null,
      note: parsed.data.note,
      quoteId: id,
    });
  }
  res.json({ quote: view(req, findQuote(id)) });
});

/* ---------------- approval workflow ---------------- */

quotesRouter.post("/:id/submit", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (!canEdit(req, quote.created_by, quote.assigned_to)) {
    res.status(403).json({ error: "Quotation ini milik pengguna lain." });
    return;
  }
  if (!EDITABLE_STATUSES.includes(quote.status)) {
    res.status(409).json({ error: "Hanya draft yang bisa diajukan." });
    return;
  }
  // Term of payment and warranty must be on the customer's document.
  const missing = missingTerms(quote.meta);
  if (missing.length) {
    res.status(400).json({ error: missingTermsMessage(missing), missing });
    return;
  }
  // Lines whose catalog COGS needs a manager are held, not offered (findQuote
  // applied the holds); the rest goes ahead. Nothing to offer -> refuse.
  if (quote.items.length && quote.items.every((it) => it.held)) {
    res.status(400).json({ error: ALL_HELD });
    return;
  }
  const { breaches, monthly_value, net_margin } = breachesFor(quote);
  const clean = isWithinPolicy(breaches);
  // A manager submitting a quote that breaks no rule is approved on the spot.
  const autoApprove = clean && hasPermission(req.user!.role, "decide_quotes");

  tx(() => {
    run(
      `INSERT INTO approvals(quote_id, requested_by, decision, breaches, monthly_value, net_margin,
                             decided_by, decided_at, note)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      req.user!.id,
      autoApprove ? "approved" : "pending",
      JSON.stringify(breaches),
      monthly_value,
      net_margin,
      autoApprove ? req.user!.id : null,
      autoApprove ? new Date().toISOString() : null,
      autoApprove ? "Otomatis disetujui: seluruh angka di dalam kebijakan." : null,
    );
    // Freeze the holds as submitted: from here on the document doesn't change by itself.
    run("UPDATE quotes SET items = ? WHERE id = ?", JSON.stringify(quote.items), id);
    run(
      `UPDATE quotes SET status = ?, approved_by = ?, approved_at = ?, updated_at = datetime('now')
        WHERE id = ?`,
      autoApprove ? "approved" : "submitted",
      autoApprove ? req.user!.id : null,
      autoApprove ? new Date().toISOString() : null,
      id,
    );
    saveRevision(id, quote.rev_no, quote, req.user!.id, autoApprove ? "Disetujui" : "Diajukan");
  });

  audit(req.user!.id, "quote", id, autoApprove ? "auto_approved" : "submitted", {
    breaches: breaches.map((b) => b.code),
    monthly_value,
    net_margin,
  });

  if (!autoApprove) {
    // Only the actual decision-maker (manager) gets the "needs your action"
    // email — admin still has decide_quotes for coverage/escalation, but
    // routing this to every admin as well just spams the people who are
    // meant to be monitoring, not approving on every quote.
    const recipients = all<{ name: string; email: string; phone: string }>(
      `SELECT name, email, phone FROM users WHERE role = 'manager' AND active = 1`,
    );
    void notifyQuoteSubmitted({
      recipients,
      quoteNumber: quote.number,
      quoteTitle: quote.title,
      submittedBy: req.user!.name,
      quoteId: id,
    });
  }

  res.json({ quote: view(req, findQuote(id)), breaches: breachesForViewer(req.user!.role, breaches), autoApproved: autoApprove });
});

quotesRouter.post("/:id/decide", requirePermission("decide_quotes"), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (quote.status !== "submitted") {
    res.status(409).json({ error: "Quotation ini tidak sedang menunggu persetujuan." });
    return;
  }
  const parsed = z
    .object({
      decision: z.enum(["approved", "rejected"]),
      note: z.string().max(1000).default(""),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  // A rejection must say why, so the rep knows what to change.
  if (parsed.data.decision === "rejected" && !parsed.data.note.trim()) {
    res.status(400).json({ error: "Penolakan wajib disertai alasan." });
    return;
  }
  const pending = get<{ id: number }>(
    "SELECT id FROM approvals WHERE quote_id = ? AND decision = 'pending' ORDER BY id DESC LIMIT 1",
    id,
  );
  const now = new Date().toISOString();

  tx(() => {
    if (pending) {
      run(
        "UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?",
        parsed.data.decision,
        req.user!.id,
        now,
        parsed.data.note,
        pending.id,
      );
    }
    run(
      // approved_by/approved_at record whoever decided, approve or reject —
      // otherwise a rejection banner has no way to say who rejected it.
      `UPDATE quotes SET status = ?, approved_by = ?, approved_at = ?, decision_note = ?,
              updated_at = datetime('now') WHERE id = ?`,
      parsed.data.decision,
      req.user!.id,
      now,
      parsed.data.note,
      id,
    );
    saveRevision(
      id,
      quote.rev_no,
      quote,
      req.user!.id,
      parsed.data.decision === "approved" ? "Disetujui" : "Ditolak",
    );
  });

  audit(req.user!.id, "quote", id, parsed.data.decision, { note: parsed.data.note });

  const submitter = get<{ name: string; email: string; phone: string }>(
    "SELECT name, email, phone FROM users WHERE id = ?",
    quote.created_by,
  );
  if (submitter) {
    void notifyQuoteDecided({
      recipient: submitter,
      quoteNumber: quote.number,
      quoteTitle: quote.title,
      decision: parsed.data.decision,
      decidedBy: req.user!.name,
      note: parsed.data.note,
      quoteId: id,
    });
  }

  res.json({ quote: view(req, findQuote(id)) });
});

quotesRouter.post("/:id/status", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (!canEdit(req, quote.created_by, quote.assigned_to)) {
    res.status(403).json({ error: "Quotation ini milik pengguna lain." });
    return;
  }
  const next = String(req.body?.status ?? "") as QuoteStatus;
  const allowed = STATUS_FLOW[quote.status] ?? [];
  if (!allowed.includes(next)) {
    res.status(409).json({
      error: `Status ${quote.status} tidak bisa langsung menjadi ${next}.`,
    });
    return;
  }
  run("UPDATE quotes SET status = ?, updated_at = datetime('now') WHERE id = ?", next, id);
  audit(req.user!.id, "quote", id, `status_${next}`);
  res.json({ quote: view(req, findQuote(id)) });
});

/** Unlocks a decided quote as a new revision, preserving the approved history. */
quotesRouter.post("/:id/reopen", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (!canEdit(req, quote.created_by, quote.assigned_to)) {
    res.status(403).json({ error: "Quotation ini milik pengguna lain." });
    return;
  }
  if (quote.status === "draft") {
    res.status(409).json({ error: "Quotation sudah berstatus draft." });
    return;
  }
  const nextRev = quote.rev_no + 1;
  tx(() => {
    saveRevision(id, quote.rev_no, quote, req.user!.id, `Ditutup sebagai revisi ${quote.rev_no}`);
    run(
      `UPDATE quotes SET status = 'draft', rev_no = ?, approved_by = NULL, approved_at = NULL,
              decision_note = NULL, updated_at = datetime('now') WHERE id = ?`,
      nextRev,
      id,
    );
    if (quote.status === "submitted") {
      // Reopening a quote that's still awaiting a decision voids that
      // request — otherwise it lingers forever in the manager's pending
      // queue, pointing at content that's already back in draft.
      run("DELETE FROM approvals WHERE quote_id = ? AND decision = 'pending'", id);
    }
  });
  audit(req.user!.id, "quote", id, "reopened", { rev_no: nextRev });
  res.json({ quote: view(req, findQuote(id)) });
});

/* ---------------- PE-2: sales check the locked "Cek harga" Excel ---------------- */

const latestSalesReview = (id: number) => {
  const r = get<{ lines: string } & Record<string, unknown>>(
    `SELECT s.id, s.rev_no, s.lines, s.rejected, s.created_at, u.name AS reviewed_by_name
       FROM sales_reviews s LEFT JOIN users u ON u.id = s.reviewed_by
      WHERE s.quote_id = ? ORDER BY s.id DESC LIMIT 1`,
    id,
  );
  return r ? { ...r, lines: JSON.parse(r.lines) } : null;
};

quotesRouter.get("/:id/sales-review", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!get("SELECT id FROM quotes WHERE id = ?", id)) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  res.json({ review: latestSalesReview(id) });
});

/**
 * All ACC: recorded, the quote stays approved. Any Tolak: the quote goes
 * back to draft as the next revision (reasons kept in sales_reviews), and the
 * managers are told, so the price is revised and approved again.
 */
quotesRouter.post("/:id/sales-review", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  if (!canEdit(req, quote.created_by, quote.assigned_to)) {
    res.status(403).json({ error: "Quotation ini milik pengguna lain." });
    return;
  }
  const parsed = salesReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  const check = checkSalesReview(quote, parsed.data);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  const rejected = check.rejected.length;
  const note = rejected ? rejectionNote(req.user!.name, check.rejected) : "";
  tx(() => {
    run(
      "INSERT INTO sales_reviews(quote_id, rev_no, reviewed_by, lines, rejected) VALUES(?, ?, ?, ?, ?)",
      id, quote.rev_no, req.user!.id, JSON.stringify(check.lines), rejected,
    );
    if (rejected) {
      saveRevision(id, quote.rev_no, quote, req.user!.id, `Ditolak sales: ${rejected} baris`);
      // Like a reopen, the note is cleared: the reasons live in sales_reviews
      // (the banner reads them there), so they can't follow the quote into
      // its next approval.
      run(
        `UPDATE quotes SET status = 'draft', rev_no = ?, approved_by = NULL, approved_at = NULL,
                decision_note = NULL, updated_at = datetime('now') WHERE id = ?`,
        quote.rev_no + 1, id,
      );
    }
  });
  audit(req.user!.id, "quote", id, rejected ? "sales_rejected" : "sales_accepted", {
    rev_no: quote.rev_no,
    rejected: check.rejected.map((l) => l.lineNo),
  });
  if (rejected) {
    const managers = all<{ name: string; email: string; phone: string }>(
      "SELECT name, email, phone FROM users WHERE role = 'manager' AND active = 1",
    );
    for (const recipient of managers) {
      void notifyQuoteDecided({
        recipient, quoteNumber: quote.number, quoteTitle: quote.title, decision: "rejected",
        decidedBy: `${req.user!.name} (cek sales)`, note, quoteId: id,
      });
    }
  }
  res.json({ quote: view(req, findQuote(id)), review: latestSalesReview(id) });
});

quotesRouter.delete("/:id", (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const quote = findQuote(id);
  if (!quote) {
    res.status(404).json({ error: "Quotation tidak ditemukan." });
    return;
  }
  const isOwnDraft = quote.created_by === req.user!.id && quote.status === "draft";
  if (!isOwnDraft && !hasPermission(req.user!.role, "delete_quotes")) {
    res.status(403).json({
      error: "Hanya draft milik sendiri yang bisa dihapus. Selain itu perlu admin.",
    });
    return;
  }
  run("DELETE FROM quotes WHERE id = ?", id);
  audit(req.user!.id, "quote", id, "deleted", { number: quote.number });
  res.json({ ok: true });
});
