/* Commercial terms box on the Dokumen tab (meeting 2026-10-05): margin,
   term of payment and warranty each get their own field. Payment and
   warranty go on the customer's document and are required to submit;
   the margin is the internal target and never printed. */

import type { QuoteMeta } from "@shared/types";
import { missingTerms, splitPaymentTerms } from "@shared/terms";

/** Empty input -> null (not set); otherwise the number. */
const numOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

export function TermsBox({
  meta,
  targetMargin,
  readOnly,
  onMeta,
  onTargetMargin,
}: {
  meta: QuoteMeta;
  targetMargin: number;
  readOnly: boolean;
  onMeta: (patch: Partial<QuoteMeta>) => void;
  onTargetMargin: (value: number) => void;
}) {
  const missing = missingTerms(meta);
  const required = (field: "paymentDays" | "warrantyYears") =>
    meta[field] == null ? { "aria-invalid": true as const, className: "input invalid" } : { className: "input" };

  return (
    <fieldset className="terms-box no-print" disabled={readOnly}>
      <legend>Syarat penawaran</legend>
      <div className="field-grid">
        <label className="field">
          <span>Margin target (%) · internal</span>
          <input
            className="input"
            type="number"
            min="0"
            max="90"
            step="0.5"
            value={Math.round(targetMargin * 1000) / 10}
            onChange={(e) => onTargetMargin(Math.min(0.9, Math.max(0, Number(e.target.value) / 100)))}
          />
          <small className="muted">Tidak tampil di penawaran customer.</small>
        </label>
        <label className="field">
          <span>Term of payment (hari) *</span>
          <input
            {...required("paymentDays")}
            type="number"
            min="0"
            max="365"
            step="1"
            placeholder="mis. 30"
            value={meta.paymentDays ?? ""}
            onChange={(e) => {
              const v = numOrNull(e.target.value);
              const days = v == null ? null : Math.min(365, Math.max(0, Math.round(v)));
              // A quote from before this field keeps its old text ("30 hari setelah
              // invoice") in the note; once the days are a number, drop them from
              // the note so the document doesn't read "30 hari 30 hari setelah invoice".
              const legacy = splitPaymentTerms(meta.payment);
              onMeta(days != null && legacy.days != null ? { paymentDays: days, payment: legacy.note } : { paymentDays: days });
            }}
          />
          <small className="muted">0 = tunai.</small>
        </label>
        <label className="field">
          <span>Keterangan pembayaran</span>
          <input
            className="input"
            placeholder="mis. setelah invoice diterima"
            value={meta.payment}
            onChange={(e) => onMeta({ payment: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Garansi (tahun) *</span>
          <input
            {...required("warrantyYears")}
            type="number"
            min="0"
            max="20"
            step="0.5"
            placeholder="mis. 1"
            value={meta.warrantyYears ?? ""}
            onChange={(e) => {
              const v = numOrNull(e.target.value);
              // Whole or half years only, matching what the server accepts.
              onMeta({ warrantyYears: v == null ? null : Math.min(20, Math.max(0, Math.round(v * 2) / 2)) });
            }}
          />
          <small className="muted">0 = tanpa garansi, 0,5 = 6 bulan.</small>
        </label>
        <label className="field">
          <span>Keterangan garansi</span>
          <input
            className="input"
            placeholder="mis. garansi resmi distributor"
            maxLength={200}
            value={meta.warrantyNote ?? ""}
            onChange={(e) => onMeta({ warrantyNote: e.target.value })}
          />
        </label>
      </div>
      {missing.length > 0 && !readOnly && (
        <p className="small" style={{ color: "var(--danger)", margin: "8px 0 0" }}>
          Wajib diisi sebelum diajukan: {missing.join(" dan ")}.
        </p>
      )}
    </fieldset>
  );
}
