/* ============================================================
   Plain-language breakdown of a quote, for sales and managers only
   (it names COGS, landed cost and margin, so it never goes to a client).

   Every sentence is built from the engine's own inputs with the engine's
   own rounding, so it cannot drift into invented numbers the way generated
   prose could. breakdown.test.ts checks, over many random quotes, that the
   price each explanation arrives at is exactly the engine's price.
   ============================================================ */

import { SCENARIOS } from "./engine.js";
import { grp, pct } from "./format.js";
import type { Assumptions, ComputedRow, EngineResult, PolicyBreach, PricingPolicy, ScenarioIndex } from "./types.js";

export interface LineExplanation {
  lineNo: number;
  name: string;
  /** Price the explained steps arrive at before any manual override; equals the engine's computed price. */
  computed: number;
  /** Price the explanation arrives at; equals the engine's price for this scenario. */
  price: number;
  margin: number;
  steps: string[];
  /** Things a reviewer should look at: below cost, under the line-margin minimum, estimated COGS. */
  flags: string[];
}

export interface QuoteBreakdown {
  headline: string;
  points: string[];
  lines: LineExplanation[];
}

const clean = (x: number): number => Number(x.toFixed(9));
const rp = (x: number) => `Rp ${grp(x)}`;

const finite = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/** Same rounding and clamping as computeEngine, so each step's figure is the one the engine used. */
function rounders(a: Assumptions) {
  const step = Math.max(1, finite(a.step) || 1);
  return {
    step,
    up: (x: number) => Math.ceil(clean(x / step)) * step,
    down: (x: number) => Math.floor(clean(x / step)) * step,
    targetMargin: Math.min(0.999, finite(a.targetMargin)),
    leaderMargin: Math.min(0.999, finite(a.leaderMargin)),
    marginFloor: Math.min(0.999, finite(a.marginFloor)),
    profitDiscount: finite(a.profitDiscount),
    rrpDiscount: finite(a.rrpDiscount),
  };
}

export function explainLine(
  row: ComputedRow,
  k: ScenarioIndex,
  a: Assumptions,
  engine: Pick<EngineResult, "logiApplied">,
  policy?: PricingPolicy,
): LineExplanation {
  const { step, up, down, targetMargin, leaderMargin, marginFloor, profitDiscount, rrpDiscount } = rounders(a);
  const steps: string[] = [];
  const flags: string[] = [];
  const cap = (x: number) => Math.min(x, row.rrp);
  const logistics = engine.logiApplied;

  steps.push(
    `Modal: COGS ${rp(row.cogs)}${row.estCogs ? " (estimasi)" : ""} + opex ${pct(a.opex)}` +
      (logistics ? ` + logistik ${pct(logistics)}` : "") +
      ` = landed cost ${rp(row.landed)} per ${row.uom || "unit"}.`,
  );

  const s1Target = up(row.target);
  const explainS1 = () => {
    steps.push(
      `Target margin ${pct(targetMargin)}: ${rp(row.landed)} ÷ (1 − ${pct(targetMargin)}) = ${rp(row.target)}, ` +
        `dibulatkan ke atas per Rp ${grp(step)} = ${rp(s1Target)}.`,
    );
    steps.push(
      s1Target > row.rrp
        ? `Itu melebihi plafon RRP ${rp(row.rrp)}, jadi harga ditahan di RRP.`
        : `Masih di bawah plafon RRP ${rp(row.rrp)}, jadi harga ${rp(s1Target)}.`,
    );
    return cap(s1Target);
  };

  let computed: number;
  if (k === 0) {
    computed = explainS1();
  } else if (k === 1) {
    if (row.role === "LEADER") {
      const leader = up(row.landed / (1 - leaderMargin));
      steps.push(
        `Item LEADER (penarik): dijual tipis dengan margin ${pct(leaderMargin)} → ${rp(leader)}` +
          (leader > row.rrp ? `, ditahan di plafon RRP ${rp(row.rrp)}.` : "."),
      );
      computed = cap(leader);
    } else if (row.role === "PROFIT") {
      const s1 = cap(s1Target);
      const fromRrp = down(row.rrp * (1 - profitDiscount));
      steps.push(
        `Item PROFIT (penutup subsidi): RRP ${rp(row.rrp)} − diskon ${pct(profitDiscount)} = ${rp(fromRrp)}, ` +
          `tidak boleh di bawah harga Full Margin ${rp(s1)}.`,
      );
      computed = Math.min(row.rrp, Math.max(s1, fromRrp));
    } else {
      steps.push("Item CORE: memakai harga Full Margin.");
      computed = explainS1();
    }
  } else {
    const discounted = down(row.rrp * (1 - rrpDiscount));
    const floor = up(row.landed / (1 - marginFloor));
    steps.push(`RRP ${rp(row.rrp)} − diskon ${pct(rrpDiscount)} = ${rp(discounted)} (dibulatkan ke bawah).`);
    steps.push(
      discounted >= floor
        ? `Masih di atas batas margin minimum ${pct(marginFloor)} (${rp(floor)}), jadi harga ${rp(cap(discounted))}.`
        : floor > row.rrp
          ? `Itu menembus margin minimum ${pct(marginFloor)} (batas ${rp(floor)}), tapi batas itu di atas plafon RRP ${rp(row.rrp)}, ` +
            `jadi harga berhenti di RRP dan marginnya di bawah minimum.`
          : `Itu menembus margin minimum ${pct(marginFloor)} (batas ${rp(floor)}), jadi harga ditahan di ${rp(floor)}.`,
    );
    computed = Math.min(row.rrp, Math.max(discounted, floor));
  }

  const price = row.prices[k];
  if (row.overridden[k]) {
    const manual = Number(row.manualPrice?.[k]);
    steps.push(
      `Harga diisi manual ${rp(manual)}` +
        (manual > row.rrp ? `, dipotong ke plafon RRP ${rp(row.rrp)}.` : ` (hitungan otomatis ${rp(computed)}).`),
    );
  }

  const margin = row.margins[k];
  const saving = (row.rrp - price) * row.qty;
  steps.push(
    `Harga akhir ${rp(price)} × ${grp(row.qty)} = ${rp(price * row.qty)}; margin ${pct(margin)}` +
      (saving > 0 ? `; klien hemat ${rp(saving)} dibanding RRP.` : "; sama dengan RRP."),
  );

  if (row.held) {
    flags.push(
      row.holdReason === "sales"
        ? "Menyusul: harganya ditolak sales, tidak ikut total"
        : "Ditahan: COGS perlu dicek manajer, tidak ikut total",
    );
  }
  if (margin < 0) flags.push("Di bawah modal");
  else if (policy && margin < policy.minLineMargin) flags.push(`Margin di bawah minimum ${pct(policy.minLineMargin)}`);
  if (row.estCogs || !(row.cogs > 0)) flags.push("COGS belum pasti");
  if (!(row.rrp > 0)) flags.push("Plafon RRP kosong");

  return { lineNo: row.lineNo, name: row.name, computed, price, margin, steps, flags };
}

export function explainQuote(
  engine: EngineResult,
  k: ScenarioIndex,
  a: Assumptions,
  policy?: PricingPolicy,
  breaches: PolicyBreach[] = [],
): QuoteBreakdown {
  const s = engine.scen[k];
  const sc = SCENARIOS[k];
  const lines = engine.rows.map((r) => explainLine(r, k, a, engine, policy));

  const headline =
    `${sc.key} ${sc.name}: nilai ${rp(s.revenue)}/bulan, laba ${rp(s.profit)}, net margin ${pct(s.margin)}` +
    (s.savings > 0 ? `, klien hemat ${pct(s.savingsPct)} dari harga RRP.` : ".");

  const points: string[] = [`Cara hitung skenario ini: ${sc.rule}`];
  points.push(
    `Total modal (landed) ${rp(s.landed)}/bulan untuk ${engine.rows.length} item; ` +
      `kontrak ${a.months} bulan bernilai ${rp(s.annual)}.`,
  );
  if (k === 0 && engine.capped) points.push(`${engine.capped} item mentok di plafon RRP, margin item itu lebih tipis dari target.`);
  if (k === 1 && !engine.rows.some((r) => r.role !== "CORE")) {
    points.push("Semua item berperan CORE, jadi harga di skenario ini sama dengan Full Margin. Tandai item LEADER/PROFIT di tab Item untuk subsidi silang.");
  } else if (k === 1) {
    points.push(
      `Subsidi: item LEADER memberi ${rp(engine.subsidy.given)}/bulan, item PROFIT menutup ${rp(engine.subsidy.recovered)}/bulan ` +
        `(tertutup ${pct(engine.subsidy.coverage)}).`,
    );
  }
  if (k === 2 && engine.floorHits) points.push(`${engine.floorHits} item ditahan di margin minimum, diskonnya tidak penuh.`);
  if (s.belowCost) points.push(`${s.belowCost} item dijual di bawah modal.`);
  if (s.lowestMargin < (policy?.minLineMargin ?? 0)) points.push(`Margin item terendah ${pct(s.lowestMargin)}.`);
  if (policy) {
    points.push(
      breaches.length
        ? `Kebijakan: ${breaches.map((b) => `${b.severity === "block" ? "DIBLOKIR" : "perlu perhatian"} — ${b.message}`).join("; ")}.`
        : `Kebijakan: semua batas terpenuhi (net margin minimum ${pct(policy.minNetMargin)}).`,
    );
  }

  return { headline, points, lines };
}
