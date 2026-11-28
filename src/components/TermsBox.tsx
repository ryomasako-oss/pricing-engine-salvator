/* Commercial terms box on the Dokumen tab (meeting 2026-10-05): margin,
   term of payment and warranty each get their own field. Payment and
   warranty go on the customer's document and are required to submit;
   the margin is the internal target and never printed. */

import type { QuoteMeta, TotalRowKey } from "@shared/types";
import { missingTerms, splitPaymentTerms } from "@shared/terms";
import { autoNotes, staleNote } from "@shared/docColumns";

/** Empty input -> null (not set); otherwise the number. */
const TOTAL_ROWS: [TotalRowKey, string][] = [
  ["subtotal", "Subtotal"],
  ["ppn", "PPN"],
  ["monthly", "Total"],
  ["contract", "Nilai kontrak"],
];

const numOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

export function TermsBox({
  meta,
  targetMargin,
  readOnly,
  onMeta,
  onTargetMargin,
}: {
  meta: QuoteMeta;
  /** Omitted for staff, who never see margins (PE-1): the margin field is not shown. */
  targetMargin?: number;
  readOnly: boolean;
  onMeta: (patch: Partial<QuoteMeta>) => void;
  onTargetMargin?: (value: number) => void;
}) {
  const missing = missingTerms(meta);
  const hiddenRows = meta.hideTotalRows ?? [];
  const required = (field: "paymentDays" | "warrantyYears") =>
    meta[field] == null ? { "aria-invalid": true as const, className: "input invalid" } : { className: "input" };

  return (
    <fieldset className="terms-box no-print" disabled={readOnly}>
      <legend>Syarat quotation</legend>
      <div className="field-grid">
        {targetMargin != null && onTargetMargin && (
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
          <small className="muted">Tidak tampil di dokumen untuk klien.</small>
        </label>
        )}
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
      <div className="check-row note-block">
        <label className="check">
          <input
            type="checkbox"
            checked={!meta.hideQty}
            onChange={(e) => onMeta({ hideQty: e.target.checked ? undefined : true })}
          />
          <span>Tampilkan Qty di dokumen</span>
        </label>
        <label className={`check${meta.hideQty ? " is-dim" : ""}`}>
          <input
            type="checkbox"
            checked={!meta.hideQty && !meta.hideLineTotal}
            disabled={!!meta.hideQty}
            onChange={(e) => onMeta({ hideLineTotal: e.target.checked ? undefined : true })}
          />
          <span>Tampilkan total per baris</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={!!meta.showImages}
            onChange={(e) => onMeta({ showImages: e.target.checked ? true : undefined })}
          />
          <span>Tampilkan foto barang di dokumen</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={!meta.hideClientSign}
            onChange={(e) => onMeta({ hideClientSign: e.target.checked ? undefined : true })}
          />
          <span>Tampilkan kolom "Disetujui oleh" (tanda tangan klien)</span>
        </label>
      </div>
      <div className={`check-row note-block${meta.hideQty ? " is-dim" : ""}`}>
        <span className="muted small">Baris total:</span>
        {TOTAL_ROWS.map(([key, label]) => (
          <label key={key} className="row gap-6">
            <input
              type="checkbox"
              checked={!meta.hideQty && !hiddenRows.includes(key)}
              disabled={!!meta.hideQty}
              onChange={(e) => {
                const next = e.target.checked ? hiddenRows.filter((k) => k !== key) : [...hiddenRows, key];
                onMeta({ hideTotalRows: next.length ? next : undefined });
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {meta.hideQty && (
        <p className="note">
          Tanpa Qty, dokumennya jadi daftar harga. Total per baris, subtotal, PPN, dan nilai kontrak ikut disembunyikan.
        </p>
      )}
      <NotesEditor meta={meta} onMeta={onMeta} />
      {missing.length > 0 && !readOnly && (
        <p className="small text-err note-block">
          Wajib diisi sebelum diajukan: {missing.join(" dan ")}.
        </p>
      )}
    </fieldset>
  );
}

/* "Note" under the table, editable per quote (Ryoma, 2026-11-28): the automatic lines are the starting point;
   the first edit stores the whole list in meta.docNotes. Bank and NPWP stay out of it: always from Pengaturan. */
function NotesEditor({ meta, onMeta }: { meta: QuoteMeta; onMeta: (patch: Partial<QuoteMeta>) => void }) {
  const auto = autoNotes(meta);
  const lines = meta.docNotes ?? auto;
  const set = (next: string[]) => onMeta({ docNotes: next });
  return (
    <div className="field note-block">
      <span>Note di dokumen</span>
      {lines.map((l, i) => {
        const now = meta.docNotes ? staleNote(l, auto) : null;
        return (
          <div key={i}>
            <div className="row gap-6">
              <input
                className="input grow"
                value={l}
                maxLength={300}
                aria-label={`Butir note ${i + 1}`}
                onChange={(e) => set(lines.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button type="button" className="btn small ghost" aria-label={`Hapus butir note ${i + 1}`} onClick={() => set(lines.filter((_, j) => j !== i))}>
                Hapus
              </button>
            </div>
            {now && (
              <div className="row gap-6 small text-warn" role="status">
                <span>Beda dengan syarat di atas: “{now}”</span>
                <button type="button" className="btn small ghost" aria-label={`Perbarui butir note ${i + 1}`} onClick={() => set(lines.map((x, j) => (j === i ? now : x)))}>
                  Perbarui
                </button>
              </div>
            )}
          </div>
        );
      })}
      <div className="row gap-6">
        {lines.length < 20 && (
          <button type="button" className="btn small" onClick={() => set([...lines, ""])}>
            Tambah butir
          </button>
        )}
        {meta.docNotes && (
          <button type="button" className="btn small ghost" onClick={() => onMeta({ docNotes: undefined })}>
            Kembalikan otomatis
          </button>
        )}
      </div>
      <span className="field-help">
        {meta.docNotes
          ? "Diubah manual: tidak lagi ikut berubah saat syarat di atas diubah. "
          : "Otomatis dari syarat di atas, bisa diubah. "}
        Rekening bank dan NPWP selalu tercetak dari Pengaturan perusahaan.
      </span>
    </div>
  );
}
