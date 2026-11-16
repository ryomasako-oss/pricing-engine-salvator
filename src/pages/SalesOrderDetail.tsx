/* Detail Sales Order: baris, pengiriman, linimasa, Batal SO, dan Kirim ulang (manage_policy). */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { Icon } from "../components/Icon";
import { LoadError } from "../components/LoadError";
import { Modal } from "../components/Modal";
import { FulfillmentBadge, SoStatusBadge, SyncBadge } from "../components/SalesOrderBadges";
import { useToast } from "../context/ToastContext";
import { fmtDate, fmtDateTime, grp, rp } from "@shared/format";
import type { SalesOrderSummary } from "./SalesOrders";

interface SoLine {
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

interface SoDetail extends SalesOrderSummary {
  quote_rev_no: number;
  fms_outbound_ref: string | null;
  customer_po_number: string | null;
  ship_to_name: string;
  ship_to_phone: string | null;
  ship_to_address: string;
  requested_date: string | null;
  note: string | null;
  lines: SoLine[];
}

interface SoEvent {
  id: number;
  kind: string;
  detail: Record<string, any> | null;
  created_at: string;
}

interface Detail {
  salesOrder: SoDetail;
  events: SoEvent[];
  parked: number;
  canCancel: boolean;
  canResend: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  "sales_order.created": "Sales Order",
  "sales_order.cancel_requested": "Permintaan batal",
};

/** One timeline line in plain words. */
function eventText(e: SoEvent): string {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "created":
      return `SO dibuat oleh ${d.by ?? "—"}: ${d.lines} baris${d.excluded ? `, ${d.excluded} baris tidak ikut` : ""}.`;
    case "sent":
      return `${TYPE_LABEL[d.type] ?? d.type} diterima FMS${d.applied === false ? `, tetapi tidak dijalankan: ${d.reason ?? "tanpa alasan"}` : ""}.`;
    case "fms_state":
      return `Gudang: ${d.label ?? d.state}${d.reason ? ` (${d.reason})` : ""}.`;
    case "cancel_requested":
      return `Minta batal oleh ${d.by ?? "—"}: ${d.reason}.`;
    case "cancel_rejected":
      return `Gudang menolak pembatalan: ${d.reason ?? "tanpa alasan"}. SO aktif lagi.`;
    case "sync_failed":
      return `${TYPE_LABEL[d.type] ?? d.type} gagal dikirim${d.parked ? " dan dihentikan" : ""}: ${d.error}`;
    case "resend":
      return `Dikirim ulang oleh ${d.by ?? "—"}.`;
    default:
      return e.kind;
  }
}

export function SalesOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<Detail>(`/sales-orders/${id}`)
      .then(setData)
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 403 ? "Fitur Sales Order belum dinyalakan." : e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(load, [load]);

  async function cancel() {
    setBusy(true);
    setModalError(null);
    try {
      await api.post(`/sales-orders/${id}/cancel`, { reason });
      setCancelling(false);
      setReason("");
      toast("Permintaan batal dikirim ke gudang. SO batal setelah gudang mengonfirmasi.", "success");
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    try {
      const r = await api.post<{ events: number }>(`/sales-orders/${id}/resend`);
      toast(`${r.events} event dikirim ulang ke FMS.`, "success");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <main className="hk-main">
        <div className="card">
          <LoadError message={loadError} onRetry={load} />
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="hk-main">
        <div className="card">
          <div className="card-body skeleton-list" role="status" aria-label="Memuat Sales Order…">
            {[0, 1, 2].map((i) => <span key={i} className="skeleton" />)}
          </div>
        </div>
      </main>
    );
  }

  const so = data.salesOrder;
  const showResend = data.canResend && (data.parked > 0 || so.sync_state === "failed");
  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <button className="link-btn" onClick={() => navigate("/sales-orders")}>
            <Icon name="back" size={14} /> Semua Sales Order
          </button>
          <h1 className="num">{so.number}</h1>
          <div className="status-bar">
            <SoStatusBadge status={so.status} />
            <FulfillmentBadge state={so.fulfillment_state} reason={so.fulfillment_reason} />
            <SyncBadge state={so.sync_state} />
            <span className="muted small">
              {so.client_name ?? "—"} · dari <Link to={`/quotes/${so.quote_id}`} className="num">{so.quote_number}</Link> rev {so.quote_rev_no} ·
              dibuat {fmtDateTime(so.created_at)} oleh {so.created_by_name ?? "—"}
            </span>
          </div>
        </div>
        <div className="row">
          {showResend && (
            <button className="btn" onClick={resend} disabled={busy}>
              {busy ? "Mengirim…" : "Kirim ulang"}
            </button>
          )}
          {data.canCancel && (
            <button className="btn danger" onClick={() => setCancelling(true)}>
              Batal SO
            </button>
          )}
        </div>
      </div>

      {so.sync_state === "failed" && so.sync_error && (
        <p className="notice error" role="alert">
          Gagal dikirim ke FMS: {so.sync_error}
          {data.parked > 0 ? " Pengiriman dihentikan sampai admin memilih Kirim ulang." : " Sistem terus mencoba lagi."}
        </p>
      )}
      {so.sync_state === "delivered" && so.sync_error && <p className="notice warn">FMS menerima, tetapi: {so.sync_error}</p>}
      {so.status === "cancel_requested" && <p className="notice info">Menunggu gudang mengonfirmasi pembatalan.</p>}

      <div className="card">
        <div className="card-head">
          <h3>Pengiriman</h3>
        </div>
        <div className="card-body field-grid">
          <div className="field"><span>Penerima</span>{so.ship_to_name}{so.ship_to_phone ? ` · ${so.ship_to_phone}` : ""}</div>
          <div className="field"><span>Alamat</span>{so.ship_to_address}</div>
          <div className="field"><span>Nomor PO klien</span>{so.customer_po_number || "—"}</div>
          <div className="field"><span>Tanggal diminta</span>{so.requested_date ? fmtDate(so.requested_date) : "—"}</div>
          <div className="field"><span>Nomor outbound FMS</span>{so.fms_outbound_ref || "—"}</div>
          <div className="field"><span>Catatan</span>{so.note || "—"}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Barang</h3>
          <span className="muted small">{grp(so.lines.length)} baris · {rp(so.total_value)}</span>
        </div>
        <div className="table-wrap">
          <table className="table stack">
            <thead>
              <tr>
                <th className="r">No</th>
                <th className="l">Barang</th>
                <th className="r">Qty</th>
                <th className="r">Harga</th>
                <th className="r">Jumlah</th>
              </tr>
            </thead>
            <tbody>
              {so.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="r num" data-label="No">{l.lineNo}</td>
                  <td className="l stack-title">
                    {l.name}
                    <div className="muted small num">{l.sku}</div>
                  </td>
                  <td className="r num nowrap" data-label="Qty">
                    {grp(l.qty)} {l.uom}
                    {l.baseQty != null && l.baseUom && l.baseUom !== l.uom && <div className="muted small">= {grp(l.baseQty)} {l.baseUom}</div>}
                  </td>
                  <td className="r num nowrap" data-label="Harga">{rp(l.price)}</td>
                  <td className="r num nowrap" data-label="Jumlah">{rp(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Linimasa</h3>
        </div>
        <div className="table-wrap">
          <table className="table stack">
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td className="l nowrap num stack-title">{fmtDateTime(e.created_at)}</td>
                  <td className="l" data-label="Kejadian">{eventText(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {cancelling && (
        <Modal
          title={`Batalkan ${so.number}?`}
          sub="Permintaan batal dikirim ke gudang. SO baru batal setelah gudang mengonfirmasi; barang yang sudah diserahkan tidak bisa dibatalkan."
          onClose={() => setCancelling(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setCancelling(false)}>Batal</button>
              <button className="btn danger" onClick={cancel} disabled={busy || reason.trim().length < 3}>
                {busy ? "Memproses…" : "Batalkan SO"}
              </button>
            </>
          }
        >
          <div className="form-stack">
            {modalError && <p className="notice error" role="alert">{modalError}</p>}
            <label className="field">
              <span>Alasan *</span>
              <textarea className="textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
        </Modal>
      )}
    </main>
  );
}
