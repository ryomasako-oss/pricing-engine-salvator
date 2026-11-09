/* The client-facing document. Everything inside .print-area is what a
   browser print or PDF export reproduces; internal margin analysis sits
   outside it and is marked no-print. */

import { SCENARIOS } from "@shared/engine";
import { fmtDate, grp, pct, rp } from "@shared/format";
import type { Assumptions, ComputedRow, DocColumnKey, DocTemplate, EngineResult, QuoteMeta, ScenarioIndex } from "@shared/types";
import { paymentLabel, warrantyLabel } from "@shared/terms";
import { heldNote, offeredRows } from "@shared/holds";
import { docCell, docLayout, docTotals } from "@shared/docColumns";

/** Cell alignment per column, by key so a client template can reorder them. */
const ALIGN: Record<DocColumnKey, string> = {
  no: "c", code: "l", name: "l", uom: "c", qty: "num", price: "num", total: "num", notes: "l",
};

export interface CompanyInfo {
  name: string;
  brand: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  npwp: string;
  bank: string;
  logo?: string;
}

interface Props {
  engine: EngineResult;
  meta: QuoteMeta;
  assumptions: Assumptions;
  scenario: ScenarioIndex;
  company: CompanyInfo;
  clientName: string;
  clientAddress?: string;
  /** The client's document template (shared/docColumns.ts); absent shows the standard document. */
  template?: DocTemplate | null;
  number: string;
  showInternal?: boolean;
  draft?: boolean;
}

export function QuotationDoc({
  engine,
  meta,
  assumptions,
  scenario,
  company,
  clientName,
  clientAddress,
  template,
  number,
  showInternal = true,
  draft,
}: Props) {
  const layout = docLayout(meta, template, "print");
  const cell = (key: DocColumnKey, r: ComputedRow) => {
    if (key === "name") return <>{r.name}{layout.codeUnderName && r.code && <div className="muted small">{r.code}</div>}</>;
    if (key === "price") return <strong>{grp(r.prices[scenario])}</strong>;
    const v = docCell(key, r, r.prices[scenario]);
    return typeof v === "number" && key !== "no" ? grp(v) : v;
  };
  const s = engine.scen[scenario];
  const sc = SCENARIOS[scenario];
  const validUntil = new Date(
    new Date(meta.date).getTime() + (meta.validity || 30) * 86400000,
  );

  return (
    <div className="quote-doc print-area" style={{ ["--c" as string]: sc.color }}>
      <div className="quote-top">
        <div>
          {company.logo ? (
            <img src={company.logo} alt={company.brand} className="quote-logo" />
          ) : (
            <div className="wordmark">{company.brand}</div>
          )}
          <div className="muted small">
            {company.name}
            {company.tagline ? `, ${company.tagline}` : ""}
          </div>
          {company.address && <div className="muted small">{company.address}</div>}
          {(company.phone || company.email) && (
            <div className="muted small">
              {[company.phone, company.email].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        <div>
          <div className="quote-title">{layout.title}</div>
          {draft && (
            <div className="small right" style={{ color: "#B42318", fontWeight: 600 }}>
              Draft — belum disetujui
            </div>
          )}
        </div>
      </div>

      <div className="quote-meta">
        <div>
          <span>Kepada</span>
          <strong>{clientName}</strong>
          {clientAddress && <span>{clientAddress}</span>}
        </div>
        <div>
          <span>Nomor</span>
          <strong>{number || meta.quoteNo}</strong>
        </div>
        <div>
          <span>Tanggal</span>
          <strong>{fmtDate(meta.date)}</strong>
        </div>
        <div>
          <span>Berlaku sampai</span>
          <strong>{fmtDate(validUntil)}</strong>
        </div>
        <div>
          <span>Term of payment</span>
          <strong>{paymentLabel(meta) || "—"}</strong>
        </div>
        <div>
          <span>Garansi</span>
          <strong>{warrantyLabel(meta) || "—"}</strong>
        </div>
        {meta.preparedBy && (
          <div>
            <span>Disiapkan oleh</span>
            <strong>{meta.preparedBy}</strong>
          </div>
        )}
      </div>

      {layout.opening && <p className="small pre-line">{layout.opening}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {layout.columns.map((c) => (
                <th key={c.key} className={c.key === "name" ? "l label-col" : ALIGN[c.key] === "l" ? "l" : undefined}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {offeredRows(engine.rows).map((r) => (
              <tr key={r.id}>
                {layout.columns.map((c) => <td key={c.key} className={ALIGN[c.key]}>{cell(c.key, r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {layout.totals && (
        <div className="quote-totals">
          {docTotals(layout, s, assumptions).map((row) => (
            <div key={row.key} className={row.key === "monthly" ? "grand" : undefined}>
              <span>{row.label}</span>
              <span className="num">{rp(row.value)}</span>
            </div>
          ))}
        </div>
      )}

      <p className="small muted">
        Harga dalam Rupiah per satuan dan belum termasuk PPN.
        Pengiriman {meta.delivery}. Penawaran berlaku {meta.validity} hari sejak tanggal di atas.
        {company.bank ? ` Pembayaran ke ${company.bank}.` : ""}
        {company.npwp ? ` NPWP ${company.npwp}.` : ""}
      </p>
      {meta.notes && <p className="small">{meta.notes}</p>}
      {heldNote(engine.rows) && <p className="small"><strong>Item menyusul:</strong> {heldNote(engine.rows)}</p>}
      {layout.closing && <p className="small pre-line">{layout.closing}</p>}

      {/* Meeting 2026-10-05: room for a wet or digital signature on both sides. */}
      <div className="quote-sign">
        <div>
          <span>Hormat kami,</span>
          <strong>{company.name}</strong>
          <div className="sign-space" aria-label="Tempat tanda tangan dan cap perusahaan" />
          <div className="sign-name">{meta.preparedBy || "Nama"}</div>
        </div>
        <div>
          <span>Disetujui oleh,</span>
          <strong>{clientName}</strong>
          <div className="sign-space" aria-label="Tempat tanda tangan customer" />
          <div className="sign-name">Nama &amp; jabatan:</div>
          <div className="sign-date">Tanggal:</div>
        </div>
      </div>

      {showInternal && (
        <div className="internal no-print">
          <strong>Analisis internal — jangan dikirim ke klien.</strong> Skenario {sc.key} {sc.name}.
          Net margin {pct(s.margin)}, profit {rp(s.profit)} per bulan, klien hemat{" "}
          {pct(s.savingsPct)} dari RRP, {s.atCeiling} dari {engine.rows.length} item berada di harga
          plafon{s.belowCost ? `, ${s.belowCost} item di bawah modal` : ""}.
        </div>
      )}
    </div>
  );
}
