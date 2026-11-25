import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { fmtDateTime } from "@shared/format";
import { DUPLICATE_STATUS, type DuplicateReport } from "../../shared/duplicateReports";

/* Laporan barang kembar dari Admin Gudang, tampil di halaman Gudang: yang menunggu di tab "Menunggu ACC Duplikat",
 * yang sudah diputuskan di tab "Riwayat". Barang yang dicentang bersama (2-10) jadi satu kartu kelompok;
 * Admin memilih satu barang yang dipakai untuk seluruh kelompok. Tabelnya sendiri, terpisah dari draf Gudang. */

interface Group {
  key: string;
  /** Baris pertama: id untuk ACC/Tolak, pelapor, waktu, status, keputusan. */
  head: DuplicateReport;
  items: { id: number; code: string; name: string }[];
  notes: string[];
}

function groupReports(rows: DuplicateReport[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const r of rows) {
    let g = byKey.get(r.group_key);
    if (!g) byKey.set(r.group_key, (g = { key: r.group_key, head: r, items: [], notes: [] }));
    for (const it of [
      { id: r.item_a_id, code: r.item_a_code, name: r.item_a_name },
      { id: r.item_b_id, code: r.item_b_code, name: r.item_b_name },
    ])
      if (!g.items.some((x) => x.id === it.id)) g.items.push(it);
    if (r.note && !g.notes.includes(r.note)) g.notes.push(r.note);
  }
  return [...byKey.values()];
}

const STATUS_BADGE = { open: "amber", approved: "green", rejected: "red" } as const;

export function DuplicateReportsSection({ status }: { status: "open" | "decided" }) {
  const { can } = useAuth();
  const toast = useToast();
  const [reports, setReports] = useState<DuplicateReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<Group | null>(null);
  const [keepItem, setKeepItem] = useState<number | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");

  async function load() {
    setLoading(true);
    try {
      const rows = await api.get<{ items: DuplicateReport[] }>(`/duplicate-reports?status=${status}`);
      setReports(rows.items);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal memuat laporan.", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    function onChange() {
      void load();
    }
    window.addEventListener("duplicate-reports-changed", onChange);
    return () => window.removeEventListener("duplicate-reports-changed", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openDecide(group: Group, d: "approved" | "rejected") {
    setDeciding(group);
    setDecision(d);
    setKeepItem(group.items[0].id);
    setDecisionNote("");
  }

  async function decide() {
    if (!deciding) return;
    if (decision === "approved" && keepItem == null) {
      toast("Pilih barang yang dipakai.", "error");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/duplicate-reports/${deciding.head.id}/decide`, {
        decision,
        keep_item_id: decision === "approved" ? keepItem : undefined,
        note: decisionNote,
      });
      toast(decision === "approved" ? "Laporan di-ACC." : "Laporan ditolak.", "success");
      setDeciding(null);
      window.dispatchEvent(new Event("duplicate-reports-changed"));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan keputusan.", "error");
    } finally {
      setBusy(false);
    }
  }

  const groups = groupReports(reports);
  const itemPairs = deciding?.items ?? [];

  if (reports.length === 0)
    return status === "open" && !loading ? (
      <div className="card-body empty">
        <h3>Tidak ada laporan duplikat yang menunggu</h3>
        <p>Laporan muncul di sini saat Admin Gudang mencentang barang kembar di Katalog lalu menekan Tandai duplikat.</p>
      </div>
    ) : null;

  return (
    <>
      <ul className="fix-list">
        {groups.map(({ key, head: r, items, notes }) => (
          <li key={key} className="fix-row draft-card">
            <div className="draft-head">
              <strong className="fix-item">
                <span>
                  {items[0].name} <span className="muted num">· {items[0].code || "tanpa kode"}</span>
                </span>
              </strong>
            </div>
            <ul className="draft-changes">
              <li className="draft-change">
                <div className="fix-main">
                  <div className="badge-row">
                    <span className="badge amber">Duplikat · {items.length} barang</span>
                    {r.status !== "open" && <span className={`badge ${STATUS_BADGE[r.status]}`}>{DUPLICATE_STATUS[r.status].label}</span>}
                  </div>
                  {items.map((item) => (
                    <div key={item.id}>
                      <strong>{item.name}</strong> <span className="muted num">· {item.code || "tanpa kode"}</span>
                      {r.kept_item_id === item.id && <span className="badge green" style={{ marginLeft: 6 }}>Dipakai</span>}
                    </div>
                  ))}
                  <div className="muted small">
                    {r.reported_by_name ?? "—"}, {fmtDateTime(r.created_at)}
                    {r.status !== "open" && r.decided_at && (
                      <> · {DUPLICATE_STATUS[r.status].label} oleh {r.decided_by_name ?? "—"}, {fmtDateTime(r.decided_at)}</>
                    )}
                  </div>
                  {notes.map((n) => <div key={n} className="fix-done"><em>{n}</em></div>)}
                  {r.decision_note && <div className="fix-done"><em>{r.decision_note}</em></div>}
                </div>
                {r.status === "open" && can("review_catalog_drafts") && (
                  <div className="fix-actions">
                    <button className="btn small primary" onClick={() => openDecide({ key, head: r, items, notes }, "approved")}>ACC</button>
                    <button className="btn small ghost danger" onClick={() => openDecide({ key, head: r, items, notes }, "rejected")}>Tolak</button>
                  </div>
                )}
              </li>
            </ul>
          </li>
        ))}
      </ul>

      {deciding && (
        <Modal
          title={decision === "approved" ? "ACC laporan duplikat" : "Tolak laporan duplikat"}
          sub={`${deciding.items.length} barang`}
          onClose={() => setDeciding(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setDeciding(null)}>Batal</button>
              <button
                className={`btn ${decision === "approved" ? "primary" : "danger"}`}
                onClick={() => void decide()}
                disabled={busy}
              >{busy ? "Menyimpan…" : "Simpan"}</button>
            </>
          }
        >
          {decision === "approved" ? (
            <>
              <p>Pilih barang yang dipakai. Barang yang tidak dipilih tetap ada di katalog sampai dihapus manual.</p>
              <div className="field">
                {itemPairs.map((item) => (
                  <label key={item.id} className="row" style={{ gap: 8, padding: "6px 0" }}>
                    <input type="radio" name="keep" checked={keepItem === item.id} onChange={() => setKeepItem(item.id)} />
                    <span>
                      <span className="muted small" style={{ display: "block" }}>{item.code || "tanpa kode"}</span>
                      <strong>{item.name}</strong>
                    </span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p>Barang-barang ini tetap terpisah di katalog dan laporan ini ditandai ditolak.</p>
          )}
          <label className="field">
            <span>Catatan keputusan (opsional)</span>
            <input className="input" maxLength={500} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="mis. pakai yang kodenya benar" />
          </label>
        </Modal>
      )}
    </>
  );
}
