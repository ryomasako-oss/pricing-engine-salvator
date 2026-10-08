/* Cek silang katalog dengan Accurate (shared/accurateReconcile.ts). Accurate
   adalah acuan awal, bukan kebenaran mutlak: panel ini menunjukkan di mana
   katalog dan Accurate tidak sepakat. Jenis yang perlu ditindak juga muncul
   di "Perlu diperbaiki" dan di email harian. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { fmtDateTime, grp } from "@shared/format";

interface Check {
  key: string;
  label: string;
  todo: string;
  notify: boolean;
  count: number;
}

interface Report {
  entity: string;
  ready: boolean;
  complete: boolean;
  lastRunAt: string | null;
  checkedAt: string | null;
  checks: Check[];
}

interface Row {
  code: string;
  name: string;
  catalog: string;
  accurate: string;
}

export function AccurateReconcile() {
  const toast = useToast();
  const [report, setReport] = useState<Report | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<Report>("/accurate/reconcile").then(setReport).catch(() => setReport(null));
  }, []);
  useEffect(load, [load]);

  const toggle = (key: string) => {
    if (open === key) return setOpen(null);
    setOpen(key);
    setRows(null);
    api.get<{ rows: Row[] }>(`/accurate/reconcile/${key}?limit=100`).then((r) => setRows(r.rows)).catch(() => setRows([]));
  };

  const recheck = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ open: number; closed: number }>("/accurate/reconcile");
      toast(`Dicek. ${r.open} jenis masalah terbuka di "Perlu diperbaiki"${r.closed ? `, ${r.closed} ditutup karena sudah beres` : ""}.`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      load();
    }
  };

  if (!report) return null;
  if (!report.ready) {
    return (
      <p className="muted small" style={{ marginTop: 12 }}>
        Cek silang dengan Accurate tersedia setelah sinkron {report.entity} selesai satu kali.
      </p>
    );
  }
  const problems = report.checks.filter((c) => c.notify && c.count > 0).length;

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--rule)", paddingTop: 12 }}>
      <div className="row-wrap" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Cek silang dengan Accurate {report.entity}</strong>{" "}
          <span className={`badge ${problems ? "amber" : "green"}`}>{problems ? `${problems} jenis perlu dicek` : "tidak ada selisih"}</span>
          <div className="muted small">
            Accurate dipakai sebagai acuan awal, tapi bisa salah; selisih di bawah perlu dinilai manajer.
            {report.checkedAt ? ` Terakhir dicek ${fmtDateTime(report.checkedAt)}.` : " Belum pernah dicek."}
            {!report.complete && " Sinkron sedang berjalan, angka bisa berubah."}
          </div>
        </div>
        <button className="btn small ghost" disabled={busy || !report.complete} onClick={recheck}>
          <Icon name="history" size={13} /> Cek ulang &amp; beri tahu
        </button>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 6 }}>
        {report.checks.map((c) => (
          <li key={c.key}>
            <button
              className="btn small ghost"
              style={{ width: "100%", justifyContent: "space-between", gap: 8, height: "auto", minHeight: 30, whiteSpace: "normal", textAlign: "left" }}
              disabled={c.count === 0}
              onClick={() => toggle(c.key)}
              aria-expanded={open === c.key}
            >
              <span>
                {c.label}
                {!c.notify && <span className="muted"> · informasi</span>}
              </span>
              <span className={`badge ${c.count === 0 ? "grey" : c.notify ? "amber" : "blue"}`} style={{ flexShrink: 0 }}>{grp(c.count)}</span>
            </button>
            {open === c.key && (
              <div className="small" style={{ padding: "6px 8px" }}>
                <div className="muted">{c.todo}</div>
                {rows === null ? (
                  <div className="muted">Memuat…</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th className="l">Kode</th>
                          <th className="l">Nama</th>
                          <th>Katalog</th>
                          <th>Accurate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.code}>
                            <td className="l">{r.code}</td>
                            <td className="l">{r.name}</td>
                            <td>{r.catalog}</td>
                            <td>{r.accurate}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {rows && c.count > rows.length && <div className="muted">Menampilkan {rows.length} dari {grp(c.count)}.</div>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
