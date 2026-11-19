/* The client-facing document. Everything inside .print-area is what a
   browser print or PDF export reproduces; internal margin analysis sits
   outside it and is marked no-print. */

import { SCENARIOS } from "@shared/engine";
import { fmtDate, grp, pct, rp } from "@shared/format";
import type { Assumptions, ComputedRow, DocColumnKey, DocTemplate, EngineResult, QuoteMeta, ScenarioIndex } from "@shared/types";
import { heldNote, offeredRows } from "@shared/holds";
import { docCell, docLayout, docNotes, docTotals } from "@shared/docColumns";
import { DEFAULT_LOGO } from "../assets/defaultLogo";

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
  /** Where the letter is written from; "Jakarta" when unset. */
  city?: string;
  logo?: string;
}

/** The preparer's signature, printed only on a final quote (GET /api/quotes/:id/signature). */
export interface DocSignature {
  name: string;
  image: string;
}

interface Props {
  engine: EngineResult;
  meta: QuoteMeta;
  assumptions: Assumptions;
  scenario: ScenarioIndex;
  company: CompanyInfo;
  clientName: string;
  clientAddress?: string;
  /** "Up:" line, the client's contact person. */
  clientContact?: string;
  signature?: DocSignature | null;
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
  clientContact,
  signature,
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
  const logo = company.logo || DEFAULT_LOGO;
  const following = heldNote(engine.rows);

  return (
    <div className="quote-doc print-area" style={{ ["--c" as string]: `var(--s${scenario + 1})` }}>
      <div className="quote-top">
        <img src={logo} alt={company.brand} className="quote-logo" />
        <div className="right small">
          <div>{company.city || "Jakarta"}, {fmtDate(meta.date)}</div>
          <div>No. <strong>{number || meta.quoteNo}</strong></div>
          {draft && <div style={{ color: "var(--doc-err)", fontWeight: 600 }}>Draft — belum disetujui</div>}
        </div>
      </div>

      <div className="quote-to small">
        <strong>Kepada Yth.</strong>
        <div>{clientName}</div>
        {clientContact && <div>Up: {clientContact}</div>}
        {clientAddress && <div className="muted">{clientAddress}</div>}
      </div>

      <p className="small">Perihal: <strong className="quote-title">{layout.title}</strong></p>
      <p className="small pre-line">{layout.opening}</p>

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

      <div className="quote-notes small">
        <strong>Note:</strong>
        <ul>
          {docNotes(meta, company).map((l) => <li key={l}>{l}</li>)}
          {following && <li>Item menyusul: {following}</li>}
          {meta.notes && <li className="pre-line">{meta.notes}</li>}
        </ul>
      </div>
      <p className="small pre-line">{layout.closing}</p>

      {/* Meeting 2026-10-05: room for a wet or digital signature on both sides. */}
      <div className="quote-sign">
        <div>
          <span>Hormat kami,</span>
          <strong>{company.name}</strong>
          {signature?.image ? (
            <img className="sign-image" src={signature.image} alt={`Tanda tangan ${signature.name}`} />
          ) : (
            <div className="sign-space" aria-label="Tempat tanda tangan dan cap perusahaan" />
          )}
          <div className="sign-name">{signature?.name || meta.preparedBy || "Nama"}</div>
        </div>
        <div>
          <span>Disetujui oleh,</span>
          <strong>{clientName}</strong>
          <div className="sign-space" aria-label="Tempat tanda tangan customer" />
          <div className="sign-name">Nama &amp; jabatan:</div>
          <div className="sign-date">Tanggal:</div>
        </div>
      </div>

      <div className="quote-foot">
        <strong>{company.name}</strong>
        {company.address && <div>{company.address}</div>}
        {(company.email || company.phone) && <div>{[company.email, company.phone].filter(Boolean).join(" · ")}</div>}
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
