/* Units proposed by warehouse staff (e.g. 1 Lusin = 12 Pcs), for managers: approve (quotes use the
   ratio from then on, and Accurate's Terapkan keeps it) or reject (the unit and its barcode go).
   Server: GET /catalog/unit-proposals, POST /catalog/:id/unit/review. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { fmtDateTime, grp } from "@shared/format";
import { ratioText } from "@shared/uom";

interface Proposal {
  id: number;
  code: string;
  name: string;
  base_uom: string;
  uom: string;
  factor: number;
  proposed_by: string | null;
  created_at: string;
  barcode: string | null;
}

export function UnitProposalsPanel({ onReviewed }: { onReviewed: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ proposals: Proposal[] }>("/catalog/unit-proposals").then((r) => setRows(r.proposals)).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  if (!rows.length) return null;

  const review = async (p: Proposal, approve: boolean) => {
    setBusy(`${p.code}:${p.uom}`);
    try {
      await api.post(`/catalog/${p.id}/unit/review`, { uom: p.uom, approve });
      toast(approve ? `Satuan ${p.uom} untuk ${p.code} disetujui.` : `Usulan satuan ${p.uom} untuk ${p.code} ditolak.`, "success");
      onReviewed();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
      load();
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Usulan satuan dari gudang</h3>
        <span className="muted small">
          {grp(rows.length)} menunggu. Sebelum disetujui, quotation tetap memakai satuan dari Accurate. Cek isinya dengan barang aslinya.
        </span>
      </div>
      <div className="card-body">
        <ul className="list-stack">
          {rows.map((p) => (
            <li key={`${p.code}:${p.uom}`} className="row-between">
              <div>
                <strong>{p.name}</strong> <span className="muted">· {p.code}</span>{" "}
                <span className="badge amber num">{ratioText(p.uom, p.factor, p.base_uom)}</span>
                <div className="muted small">
                  {p.proposed_by ? `Diusulkan ${p.proposed_by}, ` : ""}
                  {fmtDateTime(p.created_at)}
                  {p.barcode ? ` · barcode ${p.barcode}` : " · belum ada barcode"}
                </div>
              </div>
              <div className="row-wrap">
                <button className="btn small" disabled={busy === `${p.code}:${p.uom}`} onClick={() => review(p, true)}>
                  Setujui
                </button>
                <button className="btn small ghost danger" disabled={busy === `${p.code}:${p.uom}`} onClick={() => review(p, false)}>
                  Tolak
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
