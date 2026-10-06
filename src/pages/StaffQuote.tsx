/* The quotation screen for staff (PE-1, meeting 2026-10-05 #1, #4).

   Staff never receive COGS, landed cost or margin: the server sends each
   line's finished price and the totals (server/staffView.ts). While a rep
   edits, prices come from POST /quotes/preview (nothing saved); "Simpan"
   stores the lines. Cost, role, manual price, assumptions and scenario stay
   with managers, who keep the full editor. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useUnsavedGuard } from "../context/UnsavedGuardContext";
import { CatalogPicker } from "../components/CatalogPicker";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { type CompanyInfo, QuotationDoc } from "../components/QuotationDoc";
import { StatusChip } from "../components/pricing";
import { TermsBox } from "../components/TermsBox";
import { UomCell } from "../components/UomCell";
import { downloadQuotationPdf } from "../export/pdf";
import { SalesReviewBanner, SalesReviewImport, type SalesReviewRecord } from "../components/SalesReview";
import { WorkflowButtons } from "./QuoteEditor";
import { DEFAULT_ASSUMPTIONS } from "@shared/engine";
import { grp, pct, rp } from "@shared/format";
import { missingTerms, missingTermsMessage } from "@shared/terms";
import type {
  Assumptions,
  Client,
  EngineResult,
  PolicyBreach,
  Quote,
  QuoteMeta,
  ScenarioIndex,
} from "@shared/types";
import { type ItemUnits, uomChoices } from "@shared/uom";

/** A line as the server sends it to staff. */
export interface StaffLine {
  id: string;
  lineNo: number;
  code: string;
  name: string;
  uom: string;
  qty: number;
  rrp: number;
  price: number;
  notes?: string;
  priceUom?: string;
  /** COGS awaits a manager: shown, but not offered or totalled until released. */
  held?: boolean;
}

export interface StaffPricing {
  subtotal: number;
  ppnRate: number;
  ppn: number;
  total: number;
  months: number;
  contractValue: number;
  savingsPct: number;
}

/** A quote as staff receive it: no assumptions, regions or cost fields. */
export type StaffQuote = Omit<Quote, "items" | "assumptions" | "regions"> & {
  items: StaffLine[];
  pricing: StaffPricing;
  staffView: true;
};

interface Detail {
  quote: StaffQuote;
  policy: { breaches: PolicyBreach[] };
  canEdit: boolean;
}

/** What staff send: the editable fields of each line. */
const toSend = (lines: StaffLine[]) =>
  lines.map(({ id, code, name, uom, qty, rrp, notes }) => ({ id, code, name, uom, qty, rrp, notes }));

/**
 * The quotation document and PDF take an engine result; for staff it is built
 * from the server's prices, so the customer's document looks the same as a
 * manager's and nothing on it needs a cost.
 */
export function staffDocInput(q: { items: StaffLine[]; pricing: StaffPricing; scenario: ScenarioIndex }) {
  const zero = { landed: 0, profit: 0, margin: 0, annualProfit: 0, rrpValue: 0, savings: 0, leaderSavingsPct: 0, atCeiling: 0, lowestMargin: 0, belowCost: 0 };
  const s = { ...zero, revenue: q.pricing.subtotal, annual: q.pricing.contractValue, savingsPct: q.pricing.savingsPct };
  const engine = {
    rows: q.items.map((l) => ({ ...l, prices: [l.price, l.price, l.price] })),
    scen: [s, s, s],
  } as unknown as EngineResult;
  const assumptions: Assumptions = { ...DEFAULT_ASSUMPTIONS, ppn: q.pricing.ppnRate, months: q.pricing.months };
  return { engine, assumptions };
}

function policyOutcome(breaches: PolicyBreach[]): { label: string; cls: string } {
  if (breaches.some((b) => b.severity === "block")) return { label: "Butuh persetujuan manajer", cls: "amber" };
  if (breaches.length) return { label: "Lolos, dengan catatan", cls: "blue" };
  return { label: "Lolos kebijakan", cls: "green" };
}

export function StaffQuotePage() {
  const { id } = useParams();
  const quoteId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [lines, setLines] = useState<StaffLine[]>([]);
  const [meta, setMeta] = useState<QuoteMeta | null>(null);
  const [pricing, setPricing] = useState<StaffPricing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [error, setError] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [uomOptions, setUomOptions] = useState<string[]>([]);
  const [units, setUnits] = useState<Record<string, ItemUnits>>({});
  const [modal, setModal] = useState<"catalog" | "submit" | "reopen" | "sales-import" | null>(null);
  const [salesReview, setSalesReview] = useState<SalesReviewRecord | null>(null);
  const [showDoc, setShowDoc] = useState(false);
  const [cogsBlocked, setCogsBlocked] = useState<string[] | null>(null);
  const previewSeq = useRef(0);

  const load = useCallback(async () => {
    const [d, sr] = await Promise.all([
      api.get<Detail>(`/quotes/${quoteId}`),
      api.get<{ review: SalesReviewRecord | null }>(`/quotes/${quoteId}/sales-review`).catch(() => ({ review: null })),
    ]);
    setDetail(d);
    setSalesReview(sr.review);
    setLines(d.quote.items);
    setMeta(d.quote.meta);
    setPricing(d.quote.pricing);
    setDirty(false);
    setError("");
  }, [quoteId]);

  useEffect(() => {
    load().catch((e) => toast(e instanceof Error ? e.message : "Gagal memuat quotation.", "error"));
    api.get<{ clients: Client[] }>("/clients").then((r) => setClients(r.clients)).catch(() => undefined);
    api.get<{ company: CompanyInfo }>("/settings").then((r) => setCompany(r.company)).catch(() => undefined);
    api
      .get<{ options: { name: string }[] }>("/catalog/uom")
      .then((r) => setUomOptions(r.options.map((o) => o.name)))
      .catch(() => undefined);
  }, [load, toast]);

  // Units for the unit dropdowns, for every code on the quote.
  const codes = useMemo(() => [...new Set(lines.map((l) => l.code).filter(Boolean))].sort().join("|"), [lines]);
  useEffect(() => {
    if (!codes) return;
    api
      .post<{ units: Record<string, ItemUnits> }>("/catalog/units", { codes: codes.split("|") })
      .then((r) => setUnits(r.units))
      .catch(() => undefined);
  }, [codes]);

  // Prices while editing: ask the server, nothing is saved.
  useEffect(() => {
    if (!dirty || !meta) return;
    const seq = ++previewSeq.current;
    setPricingBusy(true);
    const t = setTimeout(() => {
      api
        .post<{ quote: StaffQuote }>("/quotes/preview", { quote_id: quoteId, snapshot: { items: toSend(lines), meta } })
        .then((r) => {
          if (seq !== previewSeq.current) return;
          const priced = new Map(r.quote.items.map((l) => [l.id, l]));
          setLines((ls) => ls.map((l) => ({ ...l, ...pick(priced.get(l.id)) })));
          setPricing(r.quote.pricing);
          setError("");
        })
        .catch((e) => seq === previewSeq.current && setError(e instanceof Error ? e.message : "Harga gagal dihitung."))
        .finally(() => seq === previewSeq.current && setPricingBusy(false));
    }, 350);
    return () => clearTimeout(t);
    // Lines change when a preview lands; only edits (which set dirty) should re-price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, editKey(lines), meta, quoteId]);

  useUnsavedGuard(dirty ? () => window.confirm("Ada perubahan yang belum disimpan. Tinggalkan halaman ini?") : null);

  const edit = (id: string, patch: Partial<StaffLine>) => {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const save = async () => {
    if (!detail || !meta) return;
    setSaving(true);
    try {
      const r = await api.put<{ quote: StaffQuote }>(`/quotes/${quoteId}`, {
        snapshot: { items: toSend(lines), meta },
        client_id: detail.quote.client_id,
        expected_version: detail.quote.version,
      });
      setDetail({ ...detail, quote: r.quote });
      setLines(r.quote.items);
      setPricing(r.quote.pricing);
      setDirty(false);
      toast("Tersimpan", "success");
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast("Quotation ini sudah diubah pengguna lain. Memuat ulang…", "error");
        await load();
      } else {
        toast(e instanceof Error ? e.message : "Gagal menyimpan.", "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, "success");
      setModal(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal.", "error");
    }
  };

  // Lines whose catalog COGS needs a manager are held at submit (left off the
  // offer, the rest goes ahead); show which ones when the dialog opens.
  useEffect(() => {
    if (modal !== "submit") return;
    setCogsBlocked(null);
    const cs = [...new Set(lines.map((l) => l.code).filter(Boolean))];
    if (!cs.length) return setCogsBlocked([]);
    api
      .post<{ problems: Record<string, string> }>("/catalog/cogs-check", { codes: cs })
      .then((r) => setCogsBlocked(lines.filter((l) => r.problems[l.code]).map((l) => `Baris ${l.lineNo} ${l.name}`)))
      .catch(() => setCogsBlocked([]));
  }, [modal, lines]);

  if (!detail || !meta || !pricing) {
    return (
      <main className="hk-main">
        <div className="loading"><span className="dots"><i /><i /><i /></span> Memuat quotation…</div>
      </main>
    );
  }

  const quote = detail.quote;
  const readOnly = !detail.canEdit;
  const clientName = quote.client_name ?? "Klien belum dipilih";
  const clientRecord = clients.find((c) => c.id === quote.client_id);
  const outcome = policyOutcome(detail.policy.breaches);
  const missing = missingTerms(meta);
  const docInput = staffDocInput({ items: lines, pricing, scenario: quote.scenario });
  const isResponsible = quote.created_by === user?.id || quote.assigned_to === user?.id;

  const exportPdf = () =>
    company &&
    downloadQuotationPdf({
      ...docInput,
      meta,
      scenario: quote.scenario,
      company,
      clientName,
      clientAddress: clientRecord?.address,
      number: quote.number,
      draft: !["approved", "sent", "won", "completed"].includes(quote.status),
    });

  return (
    <main className="hk-main">
      <div className="hk-page-head">
        <div>
          <button
            className="link-btn"
            onClick={() => {
              if (dirty && !window.confirm("Ada perubahan yang belum disimpan. Tinggalkan halaman ini?")) return;
              navigate("/quotes");
            }}
          >
            <Icon name="back" size={14} /> Semua quotation
          </button>
          <h1 style={{ marginTop: 4 }}>{quote.title}</h1>
          <p className="row-wrap" style={{ gap: 8 }}>
            <span className="num">{quote.number}</span>
            <StatusChip status={quote.status} />
            <span className="muted">{clientName} · {lines.length} item</span>
          </p>
        </div>
        <div className="row-wrap" style={{ gap: 8 }}>
          {!readOnly && (
            <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving || pricingBusy || !!error}>
              {saving ? "Menyimpan…" : dirty ? "Simpan" : "Tersimpan"}
            </button>
          )}
          {quote.status === "approved" && isResponsible && (
            <button className="btn" onClick={() => setModal("sales-import")}>
              <Icon name="upload" size={15} /> Import cek sales
            </button>
          )}
          <button className="btn" onClick={exportPdf} disabled={!company || dirty}>
            <Icon name="download" size={15} /> PDF
          </button>
          <WorkflowButtons
            quote={quote as unknown as Quote}
            canManage={false}
            isResponsible={isResponsible}
            blocked={detail.policy.breaches.filter((b) => b.severity === "block").length}
            onSubmit={() => (dirty ? toast("Simpan dulu sebelum mengajukan.", "error") : setModal("submit"))}
            onDecide={() => undefined}
            onReopen={() => setModal("reopen")}
            onStatus={(s) => void act(() => api.post(`/quotes/${quoteId}/status`, { status: s }), "Status diperbarui.")}
          />
        </div>
      </div>

      <SalesReviewBanner quote={quote as unknown as Quote} review={salesReview} />
      {modal === "sales-import" && (
        <SalesReviewImport
          quote={quote as unknown as Quote}
          onClose={() => setModal(null)}
          onDone={(rejected) => {
            setModal(null);
            toast(
              rejected ? `${rejected} baris ditolak. Quotation kembali ke manajer untuk perbaikan harga.` : "Semua baris ACC. Hasil cek tersimpan.",
              rejected ? "error" : "success",
            );
            void load();
          }}
        />
      )}
      {quote.status === "rejected" && quote.decision_note && (
        <p className="notice error" style={{ marginBottom: 12 }}>
          <strong>Ditolak{quote.approved_by_name ? ` oleh ${quote.approved_by_name}` : ""}:</strong> {quote.decision_note}
        </p>
      )}
      {error && <p className="notice error" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <h2>Item</h2>
          <div className="row-wrap" style={{ gap: 8 }}>
            <span className={`badge ${outcome.cls}`} title={detail.policy.breaches.map((b) => b.message).join(" ")}>
              {outcome.label}
            </span>
            {!readOnly && (
              <button className="btn small" onClick={() => setModal("catalog")}>
                <Icon name="plus" size={14} /> Tambah dari katalog
              </button>
            )}
          </div>
        </div>
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th className="l">#</th>
                <th className="l">Item</th>
                <th className="l">Satuan</th>
                <th>Qty</th>
                <th>Plafon klien</th>
                <th>Harga satuan</th>
                <th>Total</th>
                {!readOnly && <th aria-label="Hapus" />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="l muted">{i + 1}</td>
                  <td className="l">
                    <div style={{ fontWeight: 550 }}>{l.name}</div>
                    <div className="muted small">{l.code}</div>
                    {l.held && (
                      <span className="badge amber" title="Harga item ini sedang dicek manajer. Tidak ikut total dan dokumen; di dokumen ditulis sebagai item menyusul.">
                        Ditahan
                      </span>
                    )}
                  </td>
                  <td className="l">
                    <UomCell
                      value={l.uom}
                      choices={uomChoices(uomOptions, units[l.code], l.uom)}
                      label={`Satuan ${l.name}`}
                      readOnly={readOnly}
                      warning={l.priceUom ? "Rasio satuan belum ada; harga masih per " + l.priceUom : null}
                      onChange={(u) => edit(l.id, { uom: u })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell" type="number" min="0" disabled={readOnly}
                      aria-label={`Qty ${l.name}`}
                      value={l.qty}
                      onChange={(e) => edit(l.id, { qty: Math.max(0, Number(e.target.value)) })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell" type="number" min="0" disabled={readOnly}
                      aria-label={`Plafon klien ${l.name}`}
                      value={l.rrp}
                      onChange={(e) => edit(l.id, { rrp: Math.max(0, Number(e.target.value)) })}
                    />
                  </td>
                  <td className="num">{l.held ? <span className="muted">ditahan</span> : <strong>{grp(l.price)}</strong>}</td>
                  <td className="num">{l.held ? <span className="muted">—</span> : grp(l.price * l.qty)}</td>
                  {!readOnly && (
                    <td>
                      <button
                        className="icon-btn" aria-label={`Hapus ${l.name}`}
                        onClick={() => {
                          setLines((ls) => ls.filter((x) => x.id !== l.id));
                          setDirty(true);
                        }}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={8} className="muted" style={{ padding: 16 }}>Belum ada item. Tambahkan dari katalog.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card-body">
          <div className="quote-totals" style={{ opacity: pricingBusy ? 0.5 : 1 }} aria-busy={pricingBusy}>
            <div><span>Subtotal per bulan</span><span className="num">{rp(pricing.subtotal)}</span></div>
            <div><span>PPN {pct(pricing.ppnRate, 0)}</span><span className="num">{rp(pricing.ppn)}</span></div>
            <div className="grand"><span>Total per bulan</span><span className="num">{rp(pricing.total)}</span></div>
            <div><span>Nilai kontrak {pricing.months} bulan (belum PPN)</span><span className="num">{rp(pricing.contractValue)}</span></div>
            {pricing.savingsPct > 0 && (
              <div><span>Klien hemat dibanding plafon</span><span className="num">{pct(pricing.savingsPct)}</span></div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Dokumen penawaran</h2></div>
        <div className="card-body col" style={{ gap: 14 }}>
          <div className="field-grid">
            <label className="field">
              <span>Klien</span>
              <select
                className="select" disabled={readOnly} value={quote.client_id ?? ""}
                onChange={async (e) => {
                  const value = e.target.value === "" ? null : Number(e.target.value);
                  try {
                    await api.put(`/quotes/${quoteId}`, {
                      snapshot: { items: toSend(lines), meta },
                      client_id: value,
                      expected_version: quote.version,
                    });
                    await load();
                  } catch (err) {
                    toast(err instanceof Error ? err.message : "Gagal mengubah klien.", "error");
                  }
                }}
              >
                <option value="">Tanpa klien</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Masa berlaku (hari)</span>
              <input
                className="input" type="number" min="1" max="365" disabled={readOnly} value={meta.validity}
                onChange={(e) => { setMeta({ ...meta, validity: Math.max(1, Number(e.target.value)) }); setDirty(true); }}
              />
            </label>
            <label className="field">
              <span>Pengiriman</span>
              <input
                className="input" disabled={readOnly} value={meta.delivery}
                onChange={(e) => { setMeta({ ...meta, delivery: e.target.value }); setDirty(true); }}
              />
            </label>
          </div>
          <TermsBox
            meta={meta}
            readOnly={readOnly}
            onMeta={(patch) => { setMeta({ ...meta, ...patch }); setDirty(true); }}
          />
          <label className="field">
            <span>Catatan tambahan di penawaran</span>
            <textarea
              className="textarea" rows={2} disabled={readOnly} value={meta.notes}
              onChange={(e) => { setMeta({ ...meta, notes: e.target.value }); setDirty(true); }}
            />
          </label>
          <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowDoc((v) => !v)}>
            <Icon name="eye" size={15} /> {showDoc ? "Sembunyikan dokumen" : "Lihat dokumen"}
          </button>
          {showDoc && company && (
            <QuotationDoc
              {...docInput}
              meta={meta}
              scenario={quote.scenario}
              company={company}
              clientName={clientName}
              clientAddress={clientRecord?.address}
              number={quote.number}
              showInternal={false}
              draft={!["approved", "sent", "won", "completed"].includes(quote.status)}
            />
          )}
        </div>
      </div>

      {modal === "catalog" && (
        <CatalogPicker
          onClose={() => setModal(null)}
          existingCodes={new Set(lines.map((l) => l.code.trim().toLowerCase()))}
          onAdd={(picked) => {
            setLines((ls) => [
              ...ls,
              ...picked.map((p) => ({
                id: p.id, lineNo: 0, code: p.code, name: p.name, uom: p.uom, qty: p.qty, rrp: p.rrp, price: 0,
              })),
            ]);
            setDirty(true);
            setModal(null);
          }}
        />
      )}

      {modal === "submit" && (
        <Modal
          title="Ajukan quotation"
          sub={`${quote.number} · ${rp(pricing.subtotal)} per bulan`}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setModal(null)}>Batal</button>
              <button
                className="btn primary"
                disabled={missing.length > 0 || cogsBlocked == null || (lines.length > 0 && cogsBlocked.length === lines.length)}
                onClick={() => void act(() => api.post(`/quotes/${quoteId}/submit`), "Quotation diajukan.")}
              >
                Ajukan
              </button>
            </>
          }
        >
          {missing.length > 0 && <p className="notice error">{missingTermsMessage(missing)}</p>}
          {cogsBlocked && cogsBlocked.length > 0 && (
            <div className={`notice ${cogsBlocked.length === lines.length ? "error" : "warn"}`} style={{ marginTop: 8 }}>
              <strong>
                {cogsBlocked.length === lines.length
                  ? "Semua item sedang dicek manajer, jadi belum ada yang bisa diajukan:"
                  : `${cogsBlocked.length} item ditahan (harganya sedang dicek manajer) dan tidak ikut penawaran:`}
              </strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {cogsBlocked.map((b) => <li key={b}>{b}</li>)}
              </ul>
              Di dokumen ke customer, item ini ditulis sebagai "item menyusul".
            </div>
          )}
          <p className="muted small" style={{ marginTop: 10 }}>
            {outcome.cls === "amber"
              ? "Quotation ini perlu persetujuan manajer sebelum bisa dikirim ke klien."
              : "Quotation masuk antrean manajer untuk dicek."}
          </p>
        </Modal>
      )}

      {modal === "reopen" && (
        <Modal
          title="Buka revisi baru"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setModal(null)}>Batal</button>
              <button className="btn primary" onClick={() => void act(() => api.post(`/quotes/${quoteId}/reopen`), "Revisi baru dibuka.")}>
                Buka revisi
              </button>
            </>
          }
        >
          <p>Quotation kembali menjadi draft supaya bisa diubah, lalu diajukan lagi.</p>
        </Modal>
      )}
    </main>
  );
}

/** Fields the preview answers for a line. */
const pick = (l?: StaffLine) =>
  l ? { price: l.price, uom: l.uom, rrp: l.rrp, priceUom: l.priceUom, held: l.held } : {};

/** What the rep edited, ignoring the prices the preview fills in, so a preview doesn't trigger another. */
const editKey = (lines: StaffLine[]) => JSON.stringify(lines.map((l) => [l.id, l.code, l.uom, l.qty, l.rrp, l.notes]));
