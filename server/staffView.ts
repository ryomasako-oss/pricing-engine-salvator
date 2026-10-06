/* ============================================================
   PE-1 (meeting 2026-10-05 #4): staff never see or set cost data.

   Prices used to be computed in the browser from COGS, so every quote, the
   catalog and even error messages carried COGS, landed cost and margin to
   anyone logged in, and the server stored whatever COGS the browser sent.
   For a user without `view_costs` (role `rep`) the server now:

   - sends finished prices instead of their ingredients (quoteForViewer):
     per line the unit price of the active scenario, a total, and the policy
     outcome in words without numbers;
   - keeps cost fields out of the catalog, match results and messages;
   - ignores COGS, role, manual price, assumptions, regions and scenario from
     the browser (mergeStaffItems): existing lines keep what is stored, new
     lines are built from the catalog by code, and a line that isn't in the
     catalog is refused.

   Pure functions shared by the Express and Worker backends; each backend
   only loads the rows. Managers and admins get everything unchanged.
   ============================================================ */

import { z } from "zod";
import { computeEngine } from "../shared/engine.js";
import { normalizeCode } from "../shared/duplicates.js";
import { lineFromCatalog } from "../shared/match.js";
import { hasPermission } from "../shared/permissions.js";
import type { AuditEntry, CatalogItem, PolicyBreach, Quote, QuoteItem, Role } from "../shared/types.js";
import { changeLineUom, sameUom } from "../shared/uom.js";
import { metaSchema } from "./validate.js";

export const canSeeCosts = (role: Role): boolean => hasPermission(role, "view_costs");

/* ---------------- what staff may send ---------------- */

/** A line as staff send it. Cost fields may be present (an old client) but are never read. */
export const staffItemSchema = z.object({
  id: z.string().min(1).max(64),
  code: z.string().max(64).default(""),
  name: z.string().max(300).default(""),
  uom: z.string().max(32).optional(),
  qty: z.number().min(0).max(50_000),
  rrp: z.number().min(0).max(50_000_000).optional(),
  notes: z.string().max(500).optional(),
});

export const staffSnapshotSchema = z.object({
  items: z.array(staffItemSchema).max(2000),
  meta: metaSchema.optional(),
});

export type StaffItem = z.infer<typeof staffItemSchema>;

/** Catalog rows (with units) keyed by normalizeCode, for building and converting staff lines. */
export type CatalogByKey = Map<string, CatalogItem>;

/** `?` placeholders, one per lookup key (normalizeCode of each code). */
export const catalogByKeysSql = (n: number) =>
  `SELECT * FROM catalog_items WHERE lower(trim(code)) IN (${Array.from({ length: n }, () => "?").join(",")})`;

export const staffLookupKeys = (codes: string[]) => [...new Set(codes.map(normalizeCode).filter(Boolean))];

export const OUTSIDE_CATALOG =
  "Item di luar katalog hanya bisa ditambahkan manajer. Pilih item dari katalog, atau minta manajer menambahkannya.";

/**
 * The lines to store after a staff edit. A line whose id is already on the
 * quote keeps its stored cost, role and manual price; staff change only qty,
 * unit (converted with the item's ratio), ceiling and notes. A new line must
 * carry a catalog code and is built from that catalog row.
 */
export function mergeStaffItems(
  stored: QuoteItem[],
  incoming: StaffItem[],
  catalog: CatalogByKey,
): { items: QuoteItem[] } | { error: string; code?: string } {
  const byId = new Map(stored.map((it) => [it.id, it]));
  const out: QuoteItem[] = [];
  for (const [i, line] of incoming.entries()) {
    const old = byId.get(line.id);
    let next: QuoteItem;
    if (old) {
      next = { ...old, qty: line.qty, notes: line.notes ?? old.notes };
      const cat = catalog.get(normalizeCode(old.code));
      if (line.uom && !sameUom(line.uom, old.uom)) {
        // Unit first: the conversion rescales the ceiling, so a ceiling sent
        // with the same edit was still in the old unit and is not applied.
        // The catalog's spelling of a known unit ("box" -> "Box") is kept, so
        // the line's unit dropdown recognises it.
        const known = cat ? [cat.uom, ...(cat.units ?? []).map((u) => u.uom)] : [];
        const to = known.find((u) => u && sameUom(u, line.uom!)) ?? line.uom;
        next = changeLineUom(next, to, cat ? { baseUom: cat.uom || "Pcs", units: cat.units ?? [] } : undefined);
      } else if (line.rrp != null) {
        next = { ...next, rrp: Math.round(line.rrp) };
      }
    } else {
      const cat = catalog.get(normalizeCode(line.code));
      if (!cat) return { error: OUTSIDE_CATALOG, code: line.code || line.name };
      next = { ...lineFromCatalog(cat, line.qty, { uom: line.uom, rrp: line.rrp }), id: line.id };
      if (line.notes) next.notes = line.notes;
    }
    out.push({ ...next, lineNo: i + 1 });
  }
  return { items: out };
}

/**
 * Body of POST /quotes/preview: price lines without saving anything, so the
 * staff screen can show prices as they type (meeting #1, "langsung tahu
 * harga"). With a quote id the lines are merged onto that quote exactly as a
 * save would; without one they are priced with the defaults a new quote gets.
 */
export const previewInput = z.object({
  quote_id: z.number().int().positive().optional(),
  snapshot: staffSnapshotSchema,
});

/* ---------------- what staff receive ---------------- */

const STAFF_BREACH: Record<PolicyBreach["code"], string> = {
  NET_MARGIN: "Margin total di bawah batas kebijakan.",
  LINE_MARGIN: "Ada item yang marginnya di bawah batas kebijakan.",
  BASKET_DISCOUNT: "Diskon total melewati batas kebijakan.",
  BELOW_COST: "Ada item yang dijual di bawah modal.",
  VALUE_THRESHOLD: "Nilai penawaran perlu persetujuan manajer.",
  MISSING_COGS: "Ada item yang biayanya belum pasti.",
};

/** The same breaches with every number taken out of the wording; line numbers stay. */
export const breachesForViewer = (role: Role, breaches: PolicyBreach[]): PolicyBreach[] =>
  canSeeCosts(role)
    ? breaches
    : breaches.map((b) => ({ ...b, message: STAFF_BREACH[b.code] ?? "Perlu dicek manajer." }));

export interface StaffLine {
  id: string;
  lineNo: number;
  code: string;
  name: string;
  uom: string;
  qty: number;
  rrp: number;
  /** Unit price in the quote's active scenario, computed on the server. */
  price: number;
  notes?: string;
  /** Set when the unit changed without a known ratio: prices are still in this unit. */
  priceUom?: string;
  /** COGS awaits a manager: shown, but not offered or totalled (server/cogsCheck.ts applyHolds). */
  held?: boolean;
}

export interface StaffPricing {
  subtotal: number;
  ppnRate: number;
  ppn: number;
  total: number;
  months: number;
  contractValue: number;
  /** Share of the client's ceiling value they save, 0..1. */
  savingsPct: number;
}

/**
 * A quote as this user may see it. Staff get lines with a finished price and
 * a total; assumptions and regions (cost inputs) are left out.
 */
export function quoteForViewer(role: Role, quote: Quote) {
  if (canSeeCosts(role)) return quote;
  const engine = computeEngine(quote.assumptions, quote.items, quote.regions);
  const k = quote.scenario;
  const s = engine.scen[k];
  const ppnRate = Number(quote.assumptions?.ppn) || 0;
  const items: StaffLine[] = engine.rows.map((r) => ({
    id: r.id,
    lineNo: r.lineNo,
    code: r.code,
    name: r.name,
    uom: r.uom,
    qty: r.qty,
    rrp: r.rrp,
    price: r.prices[k],
    ...(r.notes ? { notes: r.notes } : {}),
    ...(r.priceUom ? { priceUom: r.priceUom } : {}),
    ...(r.held ? { held: true } : {}),
  }));
  const pricing: StaffPricing = {
    subtotal: s.revenue,
    ppnRate,
    ppn: s.revenue * ppnRate,
    total: s.revenue * (1 + ppnRate),
    months: Number(quote.assumptions?.months) || 12,
    contractValue: s.annual,
    savingsPct: s.savingsPct,
  };
  const { assumptions: _a, regions: _r, items: _i, ...rest } = quote;
  return { ...rest, items, pricing, staffView: true as const };
}

/** A quote-list row: staff don't get the margin column. */
export function quoteRowForViewer<T extends { net_margin?: number }>(role: Role, row: T) {
  if (canSeeCosts(role)) return row;
  const { net_margin: _m, ...rest } = row;
  return rest;
}

/** Approval history entries on a quote: staff see decisions, not the margin recorded with them. */
export function approvalsForViewer<T extends { net_margin?: number; breaches?: PolicyBreach[] }>(role: Role, rows: T[]) {
  if (canSeeCosts(role)) return rows;
  return rows.map(({ net_margin: _m, ...a }) => ({ ...a, breaches: breachesForViewer(role, a.breaches ?? []) }));
}

/** The policy block on GET /quotes/:id: staff get breaches without numbers, and no margin. */
export function policyForViewer(
  role: Role,
  p: { breaches: PolicyBreach[]; monthly_value: number; net_margin: number },
) {
  if (canSeeCosts(role)) return p;
  return { breaches: breachesForViewer(role, p.breaches), monthly_value: p.monthly_value };
}

const STAFF_COGS_PROBLEM = "COGS item ini perlu dicek manajer";

/** Catalog rows for staff: no COGS, and a COGS problem says only that there is one. */
export function catalogItemsForViewer<T extends { cogs?: number; cogs_problem?: string | null }>(role: Role, items: T[]) {
  if (canSeeCosts(role)) return items;
  return items.map(({ cogs: _c, ...it }) => ({
    ...it,
    cogs_problem: it.cogs_problem ? STAFF_COGS_PROBLEM : null,
  }));
}

/** code -> problem, with the numbers taken out for staff. */
export function problemsForViewer(role: Role, problems: Map<string, string>): Map<string, string> {
  if (canSeeCosts(role)) return problems;
  return new Map([...problems.keys()].map((k) => [k, STAFF_COGS_PROBLEM]));
}

/** GET /settings: staff need the company details for documents, not the pricing policy. */
export function settingsForViewer<T extends { policy: unknown; company: unknown }>(role: Role, s: T) {
  return canSeeCosts(role) ? s : { company: s.company };
}

/** Detail keys in the audit trail that carry cost or margin (submit writes net_margin). */
const COST_DETAIL_KEYS = new Set(["net_margin", "margin", "cogs", "landed", "assumptions"]);

/**
 * A quote's audit trail as this user may read it. The submit entry records
 * the net margin it was submitted at; staff see the entry without it.
 */
export function auditForViewer(role: Role, entries: AuditEntry[]): AuditEntry[] {
  if (canSeeCosts(role)) return entries;
  return entries.map((e) => {
    let detail: unknown;
    try {
      detail = JSON.parse(e.detail);
    } catch {
      return e;
    }
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return e;
    const kept = Object.fromEntries(Object.entries(detail).filter(([k]) => !COST_DETAIL_KEYS.has(k)));
    return { ...e, detail: JSON.stringify(kept) };
  });
}

export const STAFF_ASSISTANT_DENIED = "Asisten harga hanya untuk manajer dan admin.";
