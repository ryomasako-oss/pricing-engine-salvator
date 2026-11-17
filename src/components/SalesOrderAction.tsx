/* "Jadikan SO" on a quote (approved, sent or won) and its confirm dialog, or
   "Lihat SO <nomor>" once the quote has an active Sales Order. Hidden while
   the sales_order_enabled switch is off. The server re-checks everything. */

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Modal } from "./Modal";
import { useToast } from "../context/ToastContext";
import { grp, rp } from "@shared/format";
import type { QuoteStatus } from "@shared/types";

interface PreviewLine {
  lineNo: number;
  sku: string;
  name: string;
  uom: string;
  qty: number;
  baseUom: string | null;
  baseQty: number | null;
  price: number;
  amount: number;
}
interface Excluded {
  lineNo: number;
  sku: string;
  name: string;
  uom: string;
  qty: number;
  reason: string;
}
type Preview =
  | { enabled: false }
  | { enabled: true; salesOrder: { id: number; number: string }; fmsUrl: string | null }
  | {
      enabled: true;
      salesOrder: null;
      canCreate: boolean;
      client: { code: string; name: string } | null;
      defaults: { shipToName: string; shipToPhone: string; shipToAddress: string };
      lines: PreviewLine[];
      excluded: Excluded[];
      total: number;
    };

const SO_FROM: QuoteStatus[] = ["approved", "sent", "won"];
const wibToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

export function SalesOrderAction({ quoteId, status, version, onCreated }: { quoteId: number; status: QuoteStatus; version: number; onCreated: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ customerPoNumber: "", shipToName: "", shipToPhone: "", shipToAddress: "", requestedDate: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only quotes that could have an SO ask; re-asked when the quote changes.
  useEffect(() => {
    if (!SO_FROM.includes(status) && status !== "completed") return setPreview(null);
    let live = true;
    api
      .get<Preview>(`/quotes/${quoteId}/sales-order`)
      .then((p) => live && setPreview(p))
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [quoteId, status, version]);

  if (!preview?.enabled) return null;
  if (preview.salesOrder) {
    return (
      <>
        <Link className="btn" to={`/sales-orders/${preview.salesOrder.id}`}>
          Lihat SO {preview.salesOrder.number}
        </Link>
        {preview.fmsUrl && (
          <a className="btn" href={preview.fmsUrl} target="_blank" rel="noopener noreferrer">
            Buka di FMS
          </a>
        )}
      </>
    );
  }
  if (!preview.canCreate) return null;
  const p = preview;

  function start() {
    setForm({ customerPoNumber: "", ...p.defaults, requestedDate: "", note: "" });
    setError(null);
    setOpen(true);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ salesOrder: { id: number; number: string } }>(`/quotes/${quoteId}/sales-order`, form);
      setOpen(false);
      toast(`Sales Order ${r.salesOrder.number} dibuat dan dikirim ke gudang.`, "success");
      onCreated();
      navigate(`/sales-orders/${r.salesOrder.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const missing = !form.shipToName.trim() || !form.shipToAddress.trim();

  return (
    <>
      <button className="btn" onClick={start}>
        Jadikan SO
      </button>
      {open && (
        <Modal
          title="Jadikan Sales Order"
          sub={`${p.client?.name ?? "Klien belum dipilih"} · ${grp(p.lines.length)} baris dikirim ke gudang FMS Salvator. Quotation menjadi Menang.`}
          size="wide"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setOpen(false)}>Batal</button>
              <button className="btn primary" onClick={create} disabled={busy || missing || p.lines.length === 0}>
                {busy ? "Memproses…" : "Jadikan SO"}
              </button>
            </>
          }
        >
          <div className="form-stack">
            {error && <p className="notice error" role="alert">{error}</p>}
            {p.lines.length === 0 && (
              <p className="notice warn">Tidak ada baris yang bisa dikirim: semua baris tertahan atau belum cocok dengan katalog.</p>
            )}
            <div className="field-grid">
              <label className="field">
                <span>Nama penerima *</span>
                <input className="input" value={form.shipToName} onChange={set("shipToName")} maxLength={200} />
              </label>
              <label className="field">
                <span>Telepon penerima</span>
                <input className="input" value={form.shipToPhone} onChange={set("shipToPhone")} maxLength={50} inputMode="tel" />
              </label>
              <label className="field">
                <span>Nomor PO klien</span>
                <input className="input" value={form.customerPoNumber} onChange={set("customerPoNumber")} maxLength={100} />
              </label>
              <label className="field">
                <span>Tanggal diminta</span>
                <input className="input" type="date" min={wibToday()} value={form.requestedDate} onChange={set("requestedDate")} />
              </label>
            </div>
            <label className="field">
              <span>Alamat kirim *</span>
              <textarea className="textarea" rows={2} value={form.shipToAddress} onChange={set("shipToAddress")} maxLength={1000} />
            </label>
            <label className="field">
              <span>Catatan untuk gudang</span>
              <textarea className="textarea" rows={2} value={form.note} onChange={set("note")} maxLength={1000} />
            </label>

            <div className="table-wrap">
              <table className="table stack">
                <thead>
                  <tr>
                    <th className="l">Barang yang dikirim</th>
                    <th className="r">Qty</th>
                    <th className="r">Harga</th>
                    <th className="r">Jumlah</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="l stack-title">
                        {l.name}
                        <div className="muted small num">{l.sku}</div>
                      </td>
                      <td className="r num nowrap" data-label="Qty">{grp(l.qty)} {l.uom}</td>
                      <td className="r num nowrap" data-label="Harga">{rp(l.price)}</td>
                      <td className="r num nowrap" data-label="Jumlah">{rp(l.amount)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="l" colSpan={3}><strong>Total nilai (sebelum PPN)</strong></td>
                    <td className="r num nowrap" data-label="Total"><strong>{rp(p.total)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>

            {p.excluded.length > 0 && (
              <div className="notice warn">
                {grp(p.excluded.length)} baris tidak ikut ke Sales Order:
                <ul className="notice-list">
                  {p.excluded.map((e) => (
                    <li key={e.lineNo}>
                      {e.name || e.sku || `Baris ${e.lineNo}`} ({grp(e.qty)} {e.uom}): {e.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
