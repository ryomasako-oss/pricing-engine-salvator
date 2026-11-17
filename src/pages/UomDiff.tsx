/* Stock UOM Adjustment (Ryoma, 2026-11-17): SI lines whose unit is not the unit on the PI that "Jual < Beli"
   compares them with (shared/uomDiff.ts), with the sale and purchase price per base unit side by side.
   "Sesuaikan" sets the missing ratio in the app (uom_adjustments, shared/uomAdjust.ts), which every cost
   reader then uses; Accurate is not changed. Viewing needs view_costs, adjusting edit_catalog too. */

import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { HistoryTabs } from "../components/HistoryTabs";
import { LoadError } from "../components/LoadError";
import { fmtDate, grp, rp } from "@shared/format";
import { groupUomDiff, ratioKnown, type UomDiffGroup, type UomDiffRow } from "@shared/uomDiff";
import { sameUom } from "@shared/uom";
import { useAuth } from "../context/AuthContext";

interface Adjustment {
  code: string;
  uom: string;
  factor: number;
  note: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface Report {
  from: string;
  to: string;
  uomDiff: UomDiffRow[];
}

const iso = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const unitText = (unit: string, ratio: number | null, base: string) =>
  ratio === null ? "rasio belum diisi" : ratio === 1 ? "satuan dasar" : `1 ${unit} = ${grp(ratio)} ${base}`;

type Kind = "" | "no_ratio" | "ratio";

/** Units of a row that can take a ratio (not the base unit), the one still missing a ratio first. */
const adjustable = (r: UomDiffRow) =>
  [
    { uom: r.siUnit, ratio: r.siRatio },
    { uom: r.piUnit, ratio: r.piRatio },
  ]
    .filter((u) => u.uom.trim() && !sameUom(u.uom, r.baseUom))
    .sort((a, b) => Number(a.ratio !== null) - Number(b.ratio !== null));

function AdjustForm({ row, current, onDone, onCancel }: { row: UomDiffRow; current: Adjustment[]; onDone: () => void; onCancel: () => void }) {
  const units = adjustable(row);
  const [uom, setUom] = useState(units[0]?.uom ?? "");
  const existing = current.find((a) => sameUom(a.uom, uom));
  const known = units.find((u) => u.uom === uom)?.ratio;
  const [factor, setFactor] = useState(String(existing?.factor ?? known ?? ""));
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const n = Number(factor.replace(",", "."));
  if (!units.length) return <p className="muted small">Kedua satuan adalah satuan dasar; tidak ada rasio yang bisa diisi.</p>;
  return (
    <form
      className="row"
      style={{ flexWrap: "wrap", gap: "0.5rem" }}
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.put("/accurate/uom-adjustments", { code: row.code, uom, factor: n, note }));
      }}
    >
      <span>1</span>
      {units.length > 1 ? (
        <select className="select inline" value={uom} onChange={(e) => {
            const next = e.target.value;
            setUom(next);
            const had = current.find((x) => sameUom(x.uom, next));
            setFactor(String(had?.factor ?? units.find((u) => u.uom === next)?.ratio ?? ""));
            setNote(had?.note ?? "");
          }}
          aria-label="Satuan yang disesuaikan"
        >
          {units.map((u) => (
            <option key={u.uom} value={u.uom}>
              {u.uom}
            </option>
          ))}
        </select>
      ) : (
        <strong>{uom}</strong>
      )}
      <span>=</span>
      <input
        className="input"
        style={{ width: "8rem" }}
        inputMode="decimal"
        value={factor}
        onChange={(e) => setFactor(e.target.value)}
        aria-label={`Isi 1 ${uom} dalam ${row.baseUom}`}
        required
      />
      <span>{row.baseUom}</span>
      <input className="input" style={{ width: "18rem", maxWidth: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan (opsional), mis. cek fisik gudang" aria-label="Catatan penyesuaian" maxLength={300} />
      <button className="btn small primary" type="submit" disabled={busy || !(n > 0)}>
        Simpan
      </button>
      {existing && (
        <button
          className="btn small ghost"
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.del(`/accurate/uom-adjustments?code=${encodeURIComponent(row.code)}&uom=${encodeURIComponent(existing.uom)}`))}
        >
          Hapus penyesuaian
        </button>
      )}
      <button className="btn small ghost" type="button" disabled={busy} onClick={onCancel}>
        Batal
      </button>
      {error && (
        <div className="text-err small" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

export function UomDiffPage() {
  const [to, setTo] = useState(() => iso(new Date()));
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 30 * 86_400_000)));
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("");
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { can } = useAuth();
  const canAdjust = can("edit_catalog");

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([api.get<Report>(`/accurate/below-cost?from=${from}&to=${to}`), api.get<{ adjustments: Adjustment[] }>("/accurate/uom-adjustments")])
      .then(([r, a]) => {
        if (!live) return;
        setData(r);
        setAdjustments(a.adjustments);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [from, to, retry]);

  const all = data?.uomDiff ?? [];
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((r) => {
      const hay = `${r.invoiceNo} ${r.customerName} ${r.code} ${r.name} ${r.receiptNo} ${r.siUnit} ${r.piUnit}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [all, q]);
  const allGroups = useMemo(() => groupUomDiff(rows), [rows]);
  const groups = allGroups.filter((g) => !kind || (kind === "ratio") === ratioKnown(g.latest));
  const noRatio = allGroups.filter((g) => !ratioKnown(g.latest));
  const withRatio = allGroups.filter((g) => ratioKnown(g.latest));
  const lines = (gs: UomDiffGroup[]) => gs.reduce((n, g) => n + g.rows.length, 0);
  const pick = (k: Kind) => setKind(kind === k ? "" : k);
  const adjustedOf = (r: UomDiffRow) => adjustments.filter((a) => a.code === r.code);
  const shown = (r: UomDiffRow) => adjustedOf(r).filter((a) => sameUom(a.uom, r.siUnit) || sameUom(a.uom, r.piUnit));
  const filtered = !!q || !!kind;

  return (
    <main className="hk-main page-stack">
      <HistoryTabs />
      <div className="hk-page-head">
        <div>
          <h1>Stock UOM Adjustment</h1>
          <p>
            Barang yang satuannya di penjualan (SI) berbeda dengan satuan di pembelian (PI) terakhir sebelum tanggal SI, satu baris per barang dan
            satuan. Satu rasio membereskan semua SI barang itu sekaligus. Ini PI yang sama yang dipakai di
            "Jual &lt; Beli". Harga jual dan beli ditampilkan per satuan dasar supaya bisa dibandingkan langsung. Kalau rasionya belum ada atau
            salah, klik "Sesuaikan" untuk mengisi rasio di aplikasi: Jual &lt; Beli, COGS dari harga beli, dan riwayat langsung memakainya. Data di
            Accurate tidak diubah.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <label className="row">
            <span className="muted small">Dari</span>
            <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Tanggal SI dari" />
          </label>
          <label className="row">
            <span className="muted small">Sampai</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Tanggal SI sampai" />
          </label>
          <input
            className="input toolbar-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari SI, klien, kode/nama barang, PI, satuan"
            aria-label="Filter satuan"
          />
        </div>
      </div>

      {loadError ? (
        <div className="card">
          <LoadError message={loadError} onRetry={() => setRetry((r) => r + 1)} />
        </div>
      ) : loading && !data ? (
        <div className="card">
          <div className="card-body skeleton-list" role="status" aria-label="Memuat laporan…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        </div>
      ) : data ? (
        <>
          <div className="kpi-grid">
            <button type="button" className={`kpi kpi-btn${kind === "no_ratio" ? " on" : ""}${noRatio.length ? " tone-warn" : ""}`} onClick={() => pick("no_ratio")} aria-pressed={kind === "no_ratio"}>
              <div className="label">Barang dengan rasio belum diisi</div>
              <div className="value num">{grp(noRatio.length)}</div>
              <div className="foot">{grp(lines(noRatio))} baris SI · harga jual dan beli bisa salah dibandingkan. Dahulukan ini. Klik untuk menyaring.</div>
            </button>
            <button type="button" className={`kpi kpi-btn${kind === "ratio" ? " on" : ""}`} onClick={() => pick("ratio")} aria-pressed={kind === "ratio"}>
              <div className="label">Barang dengan rasio ada</div>
              <div className="value num">{grp(withRatio.length)}</div>
              <div className="foot">{grp(lines(withRatio))} baris SI · harga sudah dihitung per satuan dasar, tapi satuannya tetap tidak sama. Klik untuk menyaring.</div>
            </button>
          </div>

          <div className={`card${loading ? " is-stale" : ""}`}>
            {groups.length === 0 ? (
              <div className="card-body empty">
                {filtered ? (
                  <h3>Tidak ada barang yang cocok dengan filter</h3>
                ) : (
                  <>
                    <h3>Semua satuan SI sama dengan PI</h3>
                    <p>Tidak ada beda satuan pada {fmtDate(data.from)} – {fmtDate(data.to)}.</p>
                  </>
                )}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table stack">
                  <thead>
                    <tr>
                      <th className="l">Barang</th>
                      <th className="l">Satuan SI</th>
                      <th className="l">Satuan PI</th>
                      <th>Jumlah SI</th>
                      <th>Harga jual / satuan dasar</th>
                      <th>Harga beli / satuan dasar</th>
                      <th className="l">Keterangan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const r = g.latest;
                      return (
                        <Fragment key={g.key}>
                          <tr>
                            <td className="l stack-title" data-label="Barang">
                              <div>
                                {r.name}
                                <div className="muted small">{r.code}</div>
                              </div>
                            </td>
                            <td className="l" data-label="Satuan SI">
                              <div>
                                <strong>{r.siUnit || "(kosong)"}</strong>
                                <div className="muted small">{unitText(r.siUnit, r.siRatio, r.baseUom)}</div>
                              </div>
                            </td>
                            <td className="l" data-label="Satuan PI">
                              <div>
                                <strong>{r.piUnit || "(kosong)"}</strong>
                                <div className="muted small">
                                  {unitText(r.piUnit, r.piRatio, r.baseUom)} · {r.receiptNo}
                                </div>
                              </div>
                            </td>
                            <td className="num nowrap" data-label="Jumlah SI">
                              <div>
                                {grp(g.rows.length)} SI
                                {g.below > 0 && <div className="text-err small">{grp(g.below)} di bawah harga beli</div>}
                              </div>
                            </td>
                            <td className="num nowrap" data-label="Harga jual / dasar">
                              {r.net === null ? <span className="muted">–</span> : <>{rp(r.net)}<div className="muted small">SI terakhir, per {r.baseUom}</div></>}
                            </td>
                            <td className={`num nowrap${r.net !== null && r.cost !== null && r.net < r.cost ? " text-err" : ""}`} data-label="Harga beli / dasar">
                              {r.cost === null ? <span className="muted">–</span> : <>{rp(r.cost)}<div className="muted small">per {r.baseUom}</div></>}
                            </td>
                            <td className="l" data-label="Keterangan">
                              <ul className="hint-list">
                                <li>
                                  {ratioKnown(r) ? <span className="badge grey">Rasio ada</span> : <span className="badge amber">Rasio belum diisi</span>}
                                </li>
                                {shown(r).map((a) => (
                                  <li key={a.uom}>
                                    <span className="badge blue" title={`${a.note ? a.note + " · " : ""}${a.updatedBy ?? ""} ${fmtDate(a.updatedAt.slice(0, 10))}`}>
                                      Disesuaikan: 1 {a.uom} = {grp(a.factor)} {r.baseUom}
                                    </span>
                                  </li>
                                ))}
                                <li className="row" style={{ gap: "0.25rem 0.75rem", flexWrap: "wrap" }}>
                                {canAdjust && editing !== g.key && (
                                  <button type="button" className="link-btn small" onClick={() => setEditing(g.key)} aria-label={`Sesuaikan ${r.code} ${r.siUnit}`}>
                                    Sesuaikan ›
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="link-btn small"
                                  onClick={() => setOpen(open === g.key ? null : g.key)}
                                  aria-expanded={open === g.key}
                                  aria-label={`${open === g.key ? "Tutup" : "Lihat"} SI ${r.code} ${r.siUnit}`}
                                >
                                  {open === g.key ? "Tutup SI" : `Lihat ${grp(g.rows.length)} SI`}
                                </button>
                                </li>
                              </ul>
                            </td>
                          </tr>
                          {editing === g.key && (
                            <tr>
                              <td className="l" colSpan={7}>
                                <AdjustForm
                                  row={r}
                                  current={adjustedOf(r)}
                                  onCancel={() => setEditing(null)}
                                  onDone={() => {
                                    setEditing(null);
                                    setRetry((x) => x + 1);
                                  }}
                                />
                              </td>
                            </tr>
                          )}
                          {open === g.key && (
                            <tr>
                              <td className="l" colSpan={7}>
                                <table className="table compact" aria-label={`SI ${r.code}`}>
                                  <thead>
                                    <tr>
                                      <th className="l">Nomor SI</th>
                                      <th className="l">Tanggal</th>
                                      <th className="l">Klien</th>
                                      <th>Harga jual / dasar</th>
                                      <th>Harga beli / dasar</th>
                                      <th className="l">PI</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {g.rows.map((x, i) => (
                                      <tr key={x.invoiceNo + i}>
                                        <td className="l num nowrap stack-title">{x.invoiceNo}</td>
                                        <td className="l nowrap" data-label="Tanggal">{fmtDate(x.transDate)}</td>
                                        <td className="l" data-label="Klien">{x.customerName}</td>
                                        <td className="num nowrap" data-label="Harga jual / dasar">{x.net === null ? "–" : rp(x.net)}</td>
                                        <td className={`num nowrap${x.net !== null && x.cost !== null && x.net < x.cost ? " text-err" : ""}`} data-label="Harga beli / dasar">{x.cost === null ? "–" : rp(x.cost)}</td>
                                        <td className="l nowrap muted small" data-label="PI">
                                          {x.receiptNo}, {fmtDate(x.receiptDate)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </main>
  );
}
