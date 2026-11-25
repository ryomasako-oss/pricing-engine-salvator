import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { Icon } from "../components/Icon";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { fmtDateTime } from "@shared/format";
import { DUPLICATE_STATUS, type DuplicateReport } from "../../shared/duplicateReports";

/* "Duplikat" — antrean laporan barang kembar dari Gudang.
 *
 * Halaman ini sengaja berdiri sendiri (/duplikat) karena halaman Gudang
 * yang asli belum ada di repo ini: Gudang yang live di
 * pricing.salvator.co.id (dengan tab "Menunggu ACC" / "Riwayat" /
 * "Riwayat stok") belum pernah di-push ke repo ini.
 * Saat kode Gudang yang asli sudah di-push, jadikan halaman ini satu tab
 * di Gudang.tsx (di samping tab "Menunggu ACC") — backend-nya tidak perlu
 * diubah; cukup render halaman ini sebagai tab.
 *
 * Aturannya: laporan duplikat TIDAK masuk antrean draf Gudang lama;
 * draf stok/barcode/satuan Vee tetap jalan seperti biasa di tempatnya.
 */

const STATUS_BADGE = { open: "amber", approved: "green", rejected: "red" } as const;

export default function DuplicateReports() {
  const { can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<"open" | "decided">("open");
  const [reports, setReports] = useState<DuplicateReport[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<DuplicateReport | null>(null);
  const [keepItem, setKeepItem] = useState<number | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");

  async function load() {
    setLoading(true);
    try {
      const [rows, count] = await Promise.all([
        api.get<{ items: DuplicateReport[] }>(`/duplicate-reports?status=${status}`),
        api.get<{ open: number }>("/duplicate-reports/count"),
      ]);
      setReports(rows.items);
      setOpenCount(count.open);
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
      setStatus("open");
      void load();
    }
    window.addEventListener("duplicate-reports-changed", onChange);
    return () => window.removeEventListener("duplicate-reports-changed", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openDecide(report: DuplicateReport, d: "approved" | "rejected") {
    setDeciding(report);
    setDecision(d);
    setKeepItem(report.item_a_id);
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
      await api.post(`/duplicate-reports/${deciding.id}/decide`, {
        decision,
        keep_item_id: decision === "approved" ? keepItem : undefined,
        note: decisionNote,
      });
      toast(decision === "approved" ? "Laporan di-ACC." : "Laporan ditolak.", "success");
      setDeciding(null);
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan keputusan.", "error");
    } finally {
      setBusy(false);
    }
  }

  const itemPairs = deciding
    ? [
        { id: deciding.item_a_id, code: deciding.item_a_code, name: deciding.item_a_name },
        { id: deciding.item_b_id, code: deciding.item_b_code, name: deciding.item_b_name },
      ]
    : [];

  return (
    <main className="hk-main">
      <div className="hk-page-head">
        <div>
          <h1>Duplikat</h1>
          <p>
            Laporan barang yang terindikasi kembar dari Gudang. Admin memilih satu barang yang dipakai — barang
            yang kalah tidak dihapus otomatis; penghapusan atau penggantiannya tetap langkah manual.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="tabs">
            {(["open", "decided"] as const).map((key) => (
              <button key={key} className={status === key ? "on" : ""} onClick={() => setStatus(key)}>
                {key === "open" ? "Menunggu" : "Riwayat"}
                {key === "open" && openCount > 0 && ` (${openCount})`}
              </button>
            ))}
          </div>
          <button className="link-btn" onClick={() => void load()}>Muat ulang</button>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="loading"><span className="dots"><i /><i /><i /></span> Memuat…</div>
          ) : reports.length === 0 ? (
            <div className="empty">
              <Icon name="check" size={28} />
              <h3>{status === "open" ? "Tidak ada laporan yang menunggu" : "Belum ada riwayat"}</h3>
              <p>{status === "open" ? "Semua laporan duplikat sudah diputuskan." : ""}</p>
            </div>
          ) : (
            <ul className="list" style={{ gap: 10 }}>
              {reports.map((r) => (
                <li key={r.id} className="fix-row">
                  <div className="fix-main">
                    <div className="row-wrap" style={{ gap: 6 }}>
                      <span className={`badge ${STATUS_BADGE[r.status]}`}>{DUPLICATE_STATUS[r.status].label}</span>
                      <span className="muted small">
                        {r.reported_by_name ?? "—"} · {fmtDateTime(r.created_at)}
                      </span>
                    </div>
                    <div className="row-wrap" style={{ gap: 12, marginTop: 6 }}>
                      {[
                        { id: r.item_a_id, code: r.item_a_code, name: r.item_a_name },
                        { id: r.item_b_id, code: r.item_b_code, name: r.item_b_name },
                      ].map((item) => (
                        <div key={item.id}>
                          <div className="muted small">{item.code || "tanpa kode"}</div>
                          <strong>{item.name}</strong>
                          {r.kept_item_id === item.id && <span className="badge green" style={{ marginLeft: 6 }}>Dipakai</span>}
                        </div>
                      ))}
                    </div>
                    {r.note && <div className="small">Catatan pelapor: {r.note}</div>}
                    {r.status !== "open" && (
                      <div className="small">
                        <Icon name="check" size={12} /> {r.decided_by_name ?? "—"}, {r.decided_at && fmtDateTime(r.decided_at)}
                        {r.decision_note ? <em> — {r.decision_note}</em> : ""}
                      </div>
                    )}
                  </div>
                  {r.status === "open" && can("review_catalog_drafts") && (
                    <div className="fix-actions">
                      <button className="btn small primary" onClick={() => openDecide(r, "approved")}>ACC</button>
                      <button className="btn small danger" onClick={() => openDecide(r, "rejected")}>Tolak</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {deciding && (
        <Modal
          title={decision === "approved" ? "ACC laporan duplikat" : "Tolak laporan duplikat"}
          sub={`${deciding.item_a_name} ↔ ${deciding.item_b_name}`}
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
            <p>Kedua barang tetap terpisah di katalog dan laporan ini ditandai ditolak.</p>
          )}
          <label className="field">
            <span>Catatan keputusan (opsional)</span>
            <input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="mis. pakai yang kodenya benar" />
          </label>
        </Modal>
      )}
    </main>
  );
}
