/* Surat perubahan harga (Ryoma, 2026-11-26): from a Jual < Beli row with a real loss, the analysis of its
   SI and a draft letter to the client; another manager/admin ACCs it before it prints with a signature.
   Prices per the client's unit, before PPN. The client's prices in the app are not changed. */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { HistoryTabs } from "../components/HistoryTabs";
import { LoadError } from "../components/LoadError";
import { LossTrace } from "../components/LossTrace";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { fmtDate, grp, pct, rp } from "@shared/format";
import { groupOf } from "@shared/belowCostHints";
import { DEFAULT_ASSUMPTIONS } from "@shared/engine";
import { isFreeWithoutPaid, isRealLoss, netMargin, newPriceRefusal, type LetterLine } from "@shared/priceLetter";
import type { BelowCostRow } from "@shared/salesBelowCost";
import type { CompanyInfo, DocSignature } from "../components/QuotationDoc";
import { downloadPriceLetterPdf, letterText, type PriceLetter, type PriceLetterLine } from "../export/priceLetterPdf";

const STATUS: Record<PriceLetter["status"], { label: string; tone: string }> = {
  draft: { label: "Menunggu ACC", tone: "amber" },
  approved: { label: "Di-ACC", tone: "green" },
  rejected: { label: "Ditolak", tone: "grey" },
};

interface Analysis {
  head: { invoice_no: string; trans_date: string; customer_name: string };
  client: { id: number; name: string; address: string; contact_name: string } | null;
  rule: { minNetMargin: number; opex: number; step: number };
  rows: BelowCostRow[];
  lines: LetterLine[];
  letter: { id: number; number: string; status: string } | null;
}

const firstOfNextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
};

/** Analysis of one SI and the draft letter form. */
export function PriceLetterNewPage() {
  const [params] = useSearchParams();
  const invoice = params.get("si") ?? "";
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [effective, setEffective] = useState(firstOfNextMonth);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [tracing, setTracing] = useState<BelowCostRow | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .get<Analysis>(`/price-letters/analysis?invoice=${encodeURIComponent(invoice)}`)
      .then((r) => {
        if (!live) return;
        setData(r);
        setPrices(Object.fromEntries(r.lines.map((l) => [l.code, String(l.suggested)])));
        setPicked(Object.fromEntries(r.lines.map((l) => [l.code, true])));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [invoice, retry]);

  const chosen = useMemo(() => (data?.lines ?? []).filter((l) => picked[l.code]), [data, picked]);
  const problems = chosen.map((l) => newPriceRefusal(l, Number(prices[l.code]))).filter(Boolean) as string[];

  async function save() {
    setSaving(true);
    try {
      const r = await api.post<{ id: number; number: string }>("/price-letters", {
        invoice_no: invoice, effective_date: effective, note,
        lines: chosen.map((l) => ({ code: l.code, new_price: Number(prices[l.code]) })),
      });
      toast(`Draft surat ${r.number} disimpan, menunggu ACC.`, "success");
      navigate(`/surat-harga/${r.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="hk-main page-stack">
      <HistoryTabs />
      <div className="hk-page-head">
        <div>
          <h1>Analisa rugi {invoice}</h1>
          <p>Barang di SI ini yang dijual di bawah harga beli, penyebabnya, dan usulan harga baru untuk surat ke klien. Harga per satuan yang dibeli klien, sebelum PPN.</p>
        </div>
      </div>
      {error ? (
        <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} />
      ) : !data ? (
        <div className="card"><div className="card-body muted">Memuat…</div></div>
      ) : (
        <>
          <div className="card">
            <div className="card-body">
              <strong>{data.head.customer_name}</strong> · {fmtDate(data.head.trans_date)}
              {data.client ? (
                <div className="muted small">Klien di aplikasi: {data.client.name}{data.client.contact_name ? ` · Up: ${data.client.contact_name}` : ""}</div>
              ) : (
                <div className="muted small">Klien ini belum ada di menu Klien: surat ditujukan ke nama di SI, tanpa alamat.</div>
              )}
            </div>
          </div>

          <section className="card" aria-label="Analisa per baris SI">
            <div className="card-head"><h2>Analisa per baris</h2></div>
            <div className="table-wrap">
              <table className="table stack">
                <thead>
                  <tr>
                    <th className="l">Barang</th>
                    <th>Harga jual / dasar</th>
                    <th>Harga beli / dasar</th>
                    <th>Rugi</th>
                    <th className="l">Penyebab</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={r.code + i}>
                      <td className="l stack-title">{r.name}<div className="muted small">{r.code}</div></td>
                      <td className="num" data-label="Harga jual">{rp(r.net)}</td>
                      <td className="num" data-label="Harga beli">{rp(r.cost)}<div className="muted small">{r.receiptNo}</div></td>
                      <td className="num" data-label="Rugi"><strong>{rp(r.lossTotal)}</strong></td>
                      <td className="l" data-label="Penyebab">
                        <span className={`badge ${groupOf(r.hints).tone}`}>{groupOf(r.hints).label}</span>
                        <button type="button" className="link-btn small" onClick={() => setTracing(r)} aria-label={`Telusuri ${r.code}`}>Telusuri ›</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {(() => {
            const free = data.rows.filter((r) => isRealLoss(r) && isFreeWithoutPaid(r));
            return free.length > 0 ? (
              <div className="notice warn" role="status">
                <strong>Barang gratis tanpa barang sama yang dibayar, tidak dimasukkan ke surat:</strong>{" "}
                {[...new Set(free.map((r) => `${r.name} (${r.code})`))].join(", ")}. Di faktur barang ini tidak boleh Rp 0, tapi harganya tidak bisa
                dirata-rata. Manajer yang memutuskan: beri harga di faktur, atau naikkan harga barang yang menjadi paketnya.
              </div>
            ) : null;
          })()}
          {data.letter ? (
            <div className="notice info" role="status">
              Sudah ada surat untuk SI ini: <Link to={`/surat-harga/${data.letter.id}`}>{data.letter.number}</Link> ({STATUS[data.letter.status as PriceLetter["status"]]?.label}).
            </div>
          ) : data.lines.length === 0 ? (
            <div className="notice info" role="status">
              {data.rows.some((r) => isRealLoss(r) && isFreeWithoutPaid(r))
                ? "Tidak ada barang lain dari SI ini yang bisa masuk surat."
                : "Tidak ada barang yang benar-benar rugi di SI ini. Baris di atas kemungkinan salah catat atau bukan penjualan biasa: betulkan datanya, tidak perlu surat ke klien."}
            </div>
          ) : (
            <section className="card" aria-label="Surat perubahan harga">
              <div className="card-head">
                <h2>Surat perubahan harga</h2>
                <p className="muted small">
                  Usulan = harga beli + opex {pct(data.rule.opex, 0)} pada margin minimum {pct(data.rule.minNetMargin, 0)}, dibulatkan ke Rp {grp(data.rule.step)}. Bisa diubah, asal di atas harga beli.
                </p>
              </div>
              <div className="table-wrap">
                <table className="table stack">
                  <thead>
                    <tr>
                      <th className="l">Masuk surat</th>
                      <th className="l">Barang</th>
                      <th className="l">Satuan</th>
                      <th>Harga lama</th>
                      <th>Harga beli</th>
                      <th>Margin lama</th>
                      <th>Usulan</th>
                      <th>Harga baru</th>
                      <th>Margin baru</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => {
                      const p = Number(prices[l.code]);
                      return (
                        <tr key={l.code}>
                          <td className="l">
                            <input type="checkbox" checked={!!picked[l.code]} onChange={(e) => setPicked({ ...picked, [l.code]: e.target.checked })} aria-label={`Masukkan ${l.code} ke surat`} />
                          </td>
                          <td className="l stack-title">{l.name}<div className="muted small">{l.code}</div></td>
                          <td className="l" data-label="Satuan">{l.unit}</td>
                          <td className="num" data-label="Harga lama">{rp(l.oldPrice)}</td>
                          <td className="num" data-label="Harga beli">{rp(l.cost)}</td>
                          <td className="num" data-label="Margin lama"><span className="badge red">{pct(l.marginNow)}</span></td>
                          <td className="num" data-label="Usulan">{rp(l.suggested)}</td>
                          <td className="num" data-label="Harga baru">
                            <input className="input num" style={{ width: "8.5rem" }} inputMode="numeric" value={prices[l.code] ?? ""} onChange={(e) => setPrices({ ...prices, [l.code]: e.target.value.replace(/\D/g, "") })} aria-label={`Harga baru ${l.code}`} />
                          </td>
                          <td className="num" data-label="Margin baru">{p > 0 ? pct(netMargin(p, l.cost, data.rule.opex)) : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="card-body form-stack">
                <label className="field">
                  <span>Berlaku mulai</span>
                  <input className="input" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
                </label>
                <label className="field">
                  <span>Catatan tambahan di surat (opsional)</span>
                  <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                {problems.length > 0 && <div className="notice warn" role="alert">{problems[0]}</div>}
                <div>
                  <button type="button" className="btn primary" disabled={saving || !chosen.length || problems.length > 0 || !effective} onClick={save}>
                    Simpan draft surat
                  </button>
                </div>
              </div>
            </section>
          )}
        </>
      )}
      {tracing && <LossTrace row={tracing} onClose={() => setTracing(null)} />}
    </main>
  );
}

interface ListRow {
  id: number; number: string; invoice_no: string; customer_name: string; effective_date: string;
  status: PriceLetter["status"]; created_at: string; created_by_name: string; decided_by_name: string | null; lines: number;
}

export function PriceLettersPage() {
  const [items, setItems] = useState<ListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    api.get<{ items: ListRow[] }>("/price-letters").then((r) => setItems(r.items)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [retry]);
  return (
    <main className="hk-main page-stack">
      <HistoryTabs />
      <div className="hk-page-head">
        <div>
          <h1>Surat perubahan harga</h1>
          <p>Surat ke klien untuk barang yang dijual rugi. Buat dari tab Jual &lt; Beli (tombol "Analisa & surat" di baris yang rugi sungguhan).</p>
        </div>
      </div>
      {error ? (
        <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} />
      ) : (
        <div className="card">
          {items && items.length === 0 ? (
            <div className="card-body empty"><h3>Belum ada surat</h3></div>
          ) : (
            <div className="table-wrap">
              <table className="table stack">
                <thead>
                  <tr><th className="l">Nomor</th><th className="l">Klien</th><th className="l">SI</th><th className="l">Berlaku</th><th>Barang</th><th className="l">Dibuat</th><th className="l">Status</th></tr>
                </thead>
                <tbody>
                  {(items ?? []).map((r) => (
                    <tr key={r.id}>
                      <td className="l stack-title"><Link to={`/surat-harga/${r.id}`}>{r.number}</Link></td>
                      <td className="l" data-label="Klien">{r.customer_name}</td>
                      <td className="l" data-label="SI">{r.invoice_no}</td>
                      <td className="l" data-label="Berlaku">{fmtDate(r.effective_date)}</td>
                      <td className="num" data-label="Barang">{r.lines}</td>
                      <td className="l" data-label="Dibuat">{r.created_by_name}</td>
                      <td className="l" data-label="Status"><span className={`badge ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>{r.decided_by_name ? <div className="muted small">{r.decided_by_name}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

type Detail = PriceLetter & { id: number; created_by: number; decided_by_name: string | null; decision_note: string };
type DetailLine = PriceLetterLine & { cost: number; suggested: number; receipt_no: string };

export function PriceLetterPage() {
  const { id } = useParams();
  const { user, can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<{ letter: Detail; lines: DetailLine[] } | null>(null);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setError(null);
    Promise.all([api.get<{ letter: Detail; lines: DetailLine[] }>(`/price-letters/${id}`), api.get<{ company: CompanyInfo }>("/settings")])
      .then(([d, s]) => {
        setData(d);
        setCompany(s.company);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id, retry]);

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await api.post(`/price-letters/${id}/decide`, { decision, note });
      toast(decision === "approved" ? "Surat di-ACC." : "Surat ditolak.", "success");
      setRetry((n) => n + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function pdf() {
    if (!data || !company) return;
    let signature: DocSignature | null = null;
    if (data.letter.status === "approved") {
      const s = await api.get<{ name: string; signature: string }>(`/price-letters/${id}/signature`).catch(() => null);
      if (s?.signature) signature = { name: s.name, image: s.signature };
    }
    downloadPriceLetterPdf(data.letter, data.lines, company, signature);
  }

  if (error) return <main className="hk-main page-stack"><HistoryTabs /><LoadError message={error} onRetry={() => setRetry((n) => n + 1)} /></main>;
  if (!data || !company) return <main className="hk-main page-stack"><HistoryTabs /><div className="card"><div className="card-body muted">Memuat…</div></div></main>;
  const { letter, lines } = data;
  const words = letterText(letter, company);
  const mine = letter.created_by === user?.id;
  return (
    <main className="hk-main page-stack">
      <HistoryTabs />
      <div className="hk-page-head">
        <div>
          <h1>{letter.number}</h1>
          <p>
            <span className={`badge ${STATUS[letter.status].tone}`}>{STATUS[letter.status].label}</span> · dibuat {letter.created_by_name}
            {letter.decided_by_name ? ` · diputuskan ${letter.decided_by_name}` : ""}{letter.decision_note ? ` (${letter.decision_note})` : ""}
          </p>
        </div>
        <div className="row">
          <Link className="btn ghost" to={`/surat-harga/baru?si=${encodeURIComponent(letter.invoice_no)}`}>Analisa {letter.invoice_no}</Link>
          <button type="button" className="btn primary" onClick={pdf}>Unduh PDF</button>
        </div>
      </div>

      {letter.status === "draft" && can("decide_quotes") && (
        <div className="card">
          <div className="card-body form-stack">
            <p className="muted small">
              {mine ? "Surat ini Anda buat: ACC harus oleh manajer atau admin lain. Anda tetap bisa menariknya (Tolak)." : "Periksa harga baru di bawah, lalu ACC agar surat bisa dicetak dengan tanda tangan."}
            </p>
            <label className="field"><span>Catatan keputusan (opsional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <div className="row">
              {!mine && <button type="button" className="btn primary" disabled={busy} onClick={() => decide("approved")}>ACC surat</button>}
              <button type="button" className="btn ghost danger" disabled={busy} onClick={() => decide("rejected")}>Tolak</button>
            </div>
          </div>
        </div>
      )}

      <section className="card" aria-label="Isi surat">
        <div className="card-body letter-preview">
          <p className="muted small">Kepada Yth. <strong>{letter.client_name || letter.customer_name}</strong>{letter.client_contact ? ` · Up: ${letter.client_contact}` : ""}</p>
          <p><strong>Perihal: {words.subject}</strong></p>
          <p style={{ whiteSpace: "pre-line" }}>{words.opening}</p>
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr><th className="l">Barang</th><th className="l">Satuan</th><th>Harga lama</th><th>Harga baru</th><th>Harga beli (internal)</th><th>Margin baru (internal)</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.line_no}>
                    <td className="l stack-title">{l.name}<div className="muted small">{l.code}</div></td>
                    <td className="l" data-label="Satuan">{l.unit}</td>
                    <td className="num" data-label="Harga lama">{rp(l.old_price)}</td>
                    <td className="num" data-label="Harga baru"><strong>{rp(l.new_price)}</strong></td>
                    <td className="num muted" data-label="Harga beli">{rp(l.cost)}<div className="small">{l.receipt_no}</div></td>
                    <td className="num muted" data-label="Margin baru">{pct(netMargin(l.new_price, l.cost, DEFAULT_ASSUMPTIONS.opex))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>{words.closing}</p>
          {letter.note && <p>{letter.note}</p>}
        </div>
      </section>
    </main>
  );
}
