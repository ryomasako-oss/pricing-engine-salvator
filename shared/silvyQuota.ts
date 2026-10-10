/* ============================================================
   Silvy usage quota: the one control that actually stops spend.
   (A GCP budget only emails; the per-minute rate limit is not a cost cap.)

   Every successful question or document already writes an audit row, so the
   counters are just COUNT(*) over audit_log. Months and days are calendar
   periods in WIB (UTC+7); audit_log.created_at is UTC text.
   Pure functions here; each backend only runs the two COUNT queries.
   ============================================================ */

export interface QuotaLimits {
  /** Questions + documents, all users, per WIB calendar month. */
  monthly: number;
  /** Questions + documents, per user, per WIB calendar day. */
  perUserDay: number;
}

/** About Rp 750k a month at the heaviest realistic price (3.5-flash after January). */
export const DEFAULT_QUOTA: QuotaLimits = { monthly: 3000, perUserDay: 150 };

const positiveInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function quotaLimitsFrom(env: Record<string, string | undefined>): QuotaLimits {
  return {
    monthly: positiveInt(env.SILVY_MONTHLY_LIMIT, DEFAULT_QUOTA.monthly),
    perUserDay: positiveInt(env.SILVY_USER_DAILY_LIMIT, DEFAULT_QUOTA.perUserDay),
  };
}

const WIB_MS = 7 * 3600 * 1000;
const sql = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

/** Start of the current WIB month, as UTC "YYYY-MM-DD HH:MM:SS" (the audit_log format). */
export function monthStartUtc(now: Date): string {
  const wib = new Date(now.getTime() + WIB_MS);
  return sql(new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), 1) - WIB_MS));
}

/** Start of the current WIB day, as UTC "YYYY-MM-DD HH:MM:SS". */
export function dayStartUtc(now: Date): string {
  const wib = new Date(now.getTime() + WIB_MS);
  return sql(new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate()) - WIB_MS));
}

/** Used for both Silvy audit actions; keep in sync with the two routers. */
export const QUOTA_COUNT_SQL = {
  month: "SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'assistant' AND action IN ('ask', 'document') AND created_at >= ?",
  userDay:
    "SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'assistant' AND action IN ('ask', 'document') AND actor_id = ? AND created_at >= ?",
} as const;

export type QuotaVerdict = { ok: true } | { ok: false; message: string };

export function quotaVerdict(used: { month: number; userToday: number }, limits: QuotaLimits): QuotaVerdict {
  if (used.month >= limits.monthly)
    return { ok: false, message: `Kuota Silvy bulan ini sudah habis (${limits.monthly} pertanyaan). Hubungi admin untuk menaikkan batas.` };
  if (used.userToday >= limits.perUserDay)
    return { ok: false, message: `Anda sudah memakai kuota harian Silvy (${limits.perUserDay} pertanyaan). Coba lagi besok.` };
  return { ok: true };
}
