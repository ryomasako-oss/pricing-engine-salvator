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
import { isPendingItemProblem } from "../shared/pendingItems.js";
import { computeEngine } from "../shared/engine.js";
import { normalizeCode } from "../shared/duplicates.js";
import { lineFromCatalog } from "../shared/match.js";
import { hasPermission } from "../shared/permissions.js";
import type { AuditEntry, CatalogItem, PolicyBreach, Quote, QuoteItem, Role, ScenarioIndex } from "../shared/types.js";
import { amountInUnit, changeLineUom, type ItemUnits, priceUnitOf, sameUom } from "../shared/uom.js";
import { catalogRowFor } from "./cogsCheck.js";
import { metaSchema } from "./validate.js";

/** A new quote's scenario (S2), used when a line is priced before the quote exists. */
export const DEFAULT_STAFF_SCENARIO: ScenarioIndex = 1;

/** Set (price > 0) or clear (0) the hand-typed price for one scenario. */
function withManualPrice(item: QuoteItem, scenario: ScenarioIndex, price: number): QuoteItem {
  const manual: (number | null)[] = [...(item.manualPrice ?? [null, null, null])];
  manual[scenario] = price > 0 ? Math.round(price) : null;
  return { ...item, manualPrice: manual };
}

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
  /** Unit price the rep typed for this line (the quote's own scenario). 0 clears it; absent leaves it alone. */
  price: z.number().min(0).max(50_000_000).optional(),
  /**
   * The unit `rrp` and `price` are expressed in. The staff screen sends it so
   * a unit change never has to be guessed; without it (an older screen) values
   * sent together with a unit change are taken to be in the old unit.
   */
  valuesUom: z.string().max(32).optional(),
  notes: z.string().max(500).optional(),
});

export const staffSnapshotSchema = z.object({
  items: z.array(staffItemSchema).max(2000),
  meta: metaSchema.optional(),
});

export type StaffItem = z.infer<typeof staffItemSchema>;

/** Catalog rows (with units) keyed by normalizeCode, for building and converting staff lines. */
/** Every catalog row (with units) sharing each normalizeCode key; see catalogRowFor. */
export type CatalogByKey = Map<string, CatalogItem[]>;

/** `?` placeholders, one per lookup key (normalizeCode of each code). */
export const catalogByKeysSql = (n: number) =>
  `SELECT * FROM catalog_items WHERE lower(trim(code)) IN (${Array.from({ length: n }, () => "?").join(",")})`;

export const staffLookupKeys = (codes: string[]) => [...new Set(codes.map(normalizeCode).filter(Boolean))];

export const UNCLEAR_CODE =
  "Kode ini cocok dengan lebih dari satu item katalog (beda huruf besar/kecil). Pilih item dari katalog.";

export const OUTSIDE_CATALOG =
  "Item di luar katalog hanya bisa ditambahkan manajer. Pilih item dari katalog, atau minta manajer menambahkannya.";

/**
 * The lines to store after a staff edit. A line whose id is already on the
 * quote keeps its stored cost and role; staff change only qty, unit
 * (converted with the item's ratio), ceiling, notes and the price they type
 * for the quote's scenario (policy decides at submit whether it needs a
 * manager). A new line must carry a catalog code and is built from that row.
 */
export function mergeStaffItems(
  stored: QuoteItem[],
  incoming: StaffItem[],
  catalog: CatalogByKey,
  scenario: ScenarioIndex = DEFAULT_STAFF_SCENARIO,
): { items: QuoteItem[] } | { error: string; code?: string } {
  const byId = new Map(stored.map((it) => [it.id, it]));
  const out: QuoteItem[] = [];
  for (const [i, line] of incoming.entries()) {
    const old = byId.get(line.id);
    let next: QuoteItem;
    if (old) {
      next = { ...old, qty: line.qty, notes: line.notes ?? old.notes };
      const cat = catalogRowFor(catalog.get(normalizeCode(old.code)) ?? [], old.code);
      const unitChanged = Boolean(line.uom) && !sameUom(line.uom!, old.uom);
      if (unitChanged) {
        // Unit first: the conversion rescales the stored ceiling and price.
        // The catalog's spelling of a known unit ("box" -> "Box") is kept, so
        // the line's unit dropdown recognises it.
        const known = cat ? [cat.uom, ...(cat.units ?? []).map((u) => u.uom)] : [];
        const to = known.find((u) => u && sameUom(u, line.uom!)) ?? line.uom!;
        next = changeLineUom(next, to, cat ? { baseUom: cat.uom || "Pcs", units: cat.units ?? [] } : undefined);
      }
      // Without valuesUom (an older screen), values sent with a unit change
      // are still in the old unit and the converted stored values stand.
      const units = cat ? { baseUom: cat.uom || "Pcs", units: cat.units ?? [] } : undefined;
      const rrp = inLineUnits(line.rrp, line.valuesUom, next, units, !unitChanged);
      const price = inLineUnits(line.price, line.valuesUom, next, units, !unitChanged);
      if (rrp != null) next = { ...next, rrp: Math.round(rrp) };
      if (price != null) next = withManualPrice(next, scenario, price);
    } else {
      const rows = catalog.get(normalizeCode(line.code)) ?? [];
      if (!rows.length) return { error: OUTSIDE_CATALOG, code: line.code || line.name };
      const cat = catalogRowFor(rows, line.code.trim());
      if (!cat) return { error: UNCLEAR_CODE, code: line.code };
      next = { ...lineFromCatalog(cat, line.qty, { uom: line.uom }), id: line.id };
      if (line.notes) next.notes = line.notes;
      const units = { baseUom: cat.uom || "Pcs", units: cat.units ?? [] };
      const rrp = inLineUnits(line.rrp, line.valuesUom, next, units, true);
      const price = inLineUnits(line.price, line.valuesUom, next, units, true);
      if (rrp != null && rrp > 0) next = { ...next, rrp: Math.round(rrp) };
      if (price != null) next = withManualPrice(next, scenario, price);
    }
    out.push({ ...next, lineNo: i + 1 });
  }
  return { items: out };
}

/**
 * A ceiling or price the screen sent, in the unit the line's numbers are in
 * (priceUnitOf: the new unit after a converted change, the old one when no
 * ratio converted it). The screen names the unit it means with valuesUom, so
 * nothing is guessed: same unit -> as sent, another unit -> converted with
 * the item's ratio, or dropped when there is none. Without valuesUom (an
 * older screen) the value is taken as is only when `trustUnnamed`.
 */
function inLineUnits(
  value: number | undefined,
  valuesUom: string | undefined,
  line: QuoteItem,
  units: ItemUnits | undefined,
  trustUnnamed: boolean,
): number | undefined {
  if (value == null) return undefined;
  if (!valuesUom) return trustUnnamed ? value : undefined;
  const to = priceUnitOf(line);
  return sameUom(valuesUom, to) ? value : amountInUnit(units, valuesUom, to, value) ?? undefined;
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

/**
 * What staff are told about the policy, which is only "a manager has to look".
 * Which rule tripped, on which line, and how many lines is exactly what a rep
 * could binary-search a price against to work out COGS or the margin floor, so
 * all of it is dropped: any blocking breach becomes one line-less entry and
 * warnings (which only describe cost quality) are not shown at all.
 */
export function breachesForViewer(role: Role, breaches: PolicyBreach[]): PolicyBreach[] {
  if (canSeeCosts(role)) return breaches;
  if (!breaches.some((b) => b.severity === "block")) return [];
  return [{ code: "NEEDS_REVIEW", severity: "block", message: "Penawaran ini perlu persetujuan manajer." }];
}

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
  /** The price was typed by hand rather than computed. */
  manual?: boolean;
  /** Set when the unit changed without a known ratio: prices are still in this unit. */
  priceUom?: string;
  /** COGS awaits a manager: shown, but not offered or totalled (server/cogsCheck.ts applyHolds). */
  held?: boolean;
  /** "sales": rejected in the sales check and offered later (shared/fixTasks.ts). */
  holdReason?: "cogs" | "sales" | "new_item";
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
    ...(r.overridden[k] ? { manual: true } : {}),
    ...(r.priceUom ? { priceUom: r.priceUom } : {}),
    ...(r.held ? { held: true } : {}),
    ...(r.holdReason ? { holdReason: r.holdReason } : {}),
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
  // A pending "barang baru" says nothing about costs, so staff get its text as it is.
  return new Map([...problems].map(([k, v]) => [k, isPendingItemProblem(v) ? v : STAFF_COGS_PROBLEM]));
}

/** GET /settings: staff need the company details for documents, not the pricing policy. */
export function settingsForViewer<T extends { policy: unknown; company: unknown }>(role: Role, s: T) {
  return canSeeCosts(role) ? s : { company: s.company };
}

/**
 * Detail keys in the audit trail staff don't get: cost or margin (submit
 * writes net_margin), and the policy rules a submit tripped (`breaches`),
 * which would let a rep probe prices just as the breach list would (see
 * breachesForViewer); the quote's status already tells them a manager decides.
 */
const COST_DETAIL_KEYS = new Set(["net_margin", "margin", "cogs", "landed", "assumptions", "breaches"]);

/**
 * A quote's audit trail as this user may read it. The submit entry records
 * the net margin and the rules it tripped; staff see the entry without them.
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
