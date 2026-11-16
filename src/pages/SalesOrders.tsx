/* ============================================================
   Pricing Engine Salvator — Sales Orders Page
   List and monitor Sales Orders integrated with FMS Salvator.
   ============================================================ */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import {
  type SalesOrder,
  type SalesOrderEvent,
  type SalesOrderStatus,
  SO_STATUS_LABELS,
  SO_STATUS_BADGE_TONE,
  canCancelSo,
} from "../../shared/salesOrder";

export function SalesOrdersPage() {
  const [items, setItems] = useState<SalesOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Detail drawer / modal
  const [selectedSo, setSelectedSo] = useState<SalesOrder | null>(null);
  const [events, setEvents] = useState<SalesOrderEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  // Cancel dialog
  const [cancelModalSo, setCancelModalSo] = useState<SalesOrder | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (searchQuery) params.set("q", searchQuery);

      const res = await fetch(`/api/sales-orders?${params.toString()}`);
      if (!res.ok) throw new Error("Gagal memuat daftar Sales Order.");
      const data = (await res.json()) as { items: SalesOrder[]; total: number };
      setItems(data.items);
      setTotal(data.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [statusFilter]);

  async function openDetail(so: SalesOrder) {
    setSelectedSo(so);
    setLoadingEvents(true);
    try {
      const res = await fetch(`/api/sales-orders/${so.id}`);
      if (res.ok) {
        const data = (await res.json()) as { salesOrder: SalesOrder; events: SalesOrderEvent[] };
        setSelectedSo(data.salesOrder);
        setEvents(data.events);
      }
    } finally {
      setLoadingEvents(false);
    }
  }

  async function handleCancelSo() {
    if (!cancelModalSo || !cancelReason.trim()) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/sales-orders/${cancelModalSo.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason }),
      });
      if (!res.ok) {
        const errJson = (await res.json()) as { error?: string };
        throw new Error(errJson.error || "Gagal membatalkan Sales Order.");
      }
      setCancelModalSo(null);
      setCancelReason("");
      await loadData();
      if (selectedSo?.id === cancelModalSo.id) {
        await openDetail(cancelModalSo);
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <main className="hk-main" id="isi">
      <div className="card">
        <div className="card-header row wrap" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 className="hk-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Icon name="truck" size={20} />
              Daftar Sales Order
            </h2>
            <span className="muted small">
              Integrasi langsung ke FMS Salvator untuk pemenuhan gudang & pelacakan status. Total: {total} pesanan.
            </span>
          </div>

          <div className="row wrap gap-sm">
            <input
              type="text"
              placeholder="Cari No. SO, No. Quote, Klien…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadData()}
              className="hk-input"
              style={{ width: "240px" }}
            />
            <button className="btn outline" onClick={loadData}>
              <Icon name="search" size={14} /> Cari
            </button>
          </div>
        </div>

        <div className="card-body" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="row wrap gap-sm" style={{ alignItems: "center" }}>
            <span className="small muted">Filter Status:</span>
            <button
              className={`btn btn-sm ${statusFilter === "" ? "primary" : "ghost"}`}
              onClick={() => setStatusFilter("")}
            >
              Semua
            </button>
            {(["CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "ON_HOLD", "CANCELLED"] as SalesOrderStatus[]).map((st) => (
              <button
                key={st}
                className={`btn btn-sm ${statusFilter === st ? "primary" : "ghost"}`}
                onClick={() => setStatusFilter(st)}
              >
                {SO_STATUS_LABELS[st]}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="card-body" style={{ color: "var(--red)", background: "var(--red-tint)" }}>
            {error}
          </div>
        )}

        <div className="card-body" style={{ padding: 0 }}>
          {loading ? (
            <div className="skeleton-list" style={{ padding: "1.5rem" }}>
              {[1, 2, 3, 4].map((i) => <span key={i} className="skeleton" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="empty" style={{ padding: "3rem" }}>
              <h3>Belum ada Sales Order</h3>
              <p className="muted">Sales Order dibuat dari Quotation yang telah disetujui.</p>
            </div>
          ) : (
            <div className="table-responsive">
              <table className="hk-table">
                <thead>
                  <tr>
                    <th>No. Sales Order</th>
                    <th>Quotation</th>
                    <th>Klien</th>
                    <th>Status FMS</th>
                    <th>Kurir & Resi</th>
                    <th style={{ textAlign: "right" }}>Total Nilai</th>
                    <th>Waktu Dibuat</th>
                    <th style={{ textAlign: "center" }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((so) => (
                    <tr key={so.id}>
                      <td style={{ fontWeight: 600 }}>
                        <button
                          className="link-btn"
                          onClick={() => openDetail(so)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--action)", fontWeight: "bold" }}
                        >
                          {so.orderNo}
                        </button>
                      </td>
                      <td>
                        <Link to={`/quotes/${so.quoteId}`} className="small">
                          {so.quoteNumber}
                        </Link>
                      </td>
                      <td>
                        <div>{so.clientName}</div>
                        <span className="muted small">{so.clientCode}</span>
                      </td>
                      <td>
                        <span className={`badge ${SO_STATUS_BADGE_TONE[so.status]}`}>
                          {SO_STATUS_LABELS[so.status] || so.status}
                        </span>
                      </td>
                      <td>
                        {so.trackingNo ? (
                          <div>
                            <span style={{ fontWeight: 600 }}>{so.courierCode || "Kurir"}:</span>{" "}
                            <code>{so.trackingNo}</code>
                          </div>
                        ) : (
                          <span className="muted small">{so.shipping?.courierCode || "Belum ada resi"}</span>
                        )}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>
                        Rp {so.totalAmount.toLocaleString("id-ID")}
                      </td>
                      <td className="small muted">
                        {new Date(so.createdAt).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <div className="row gap-xs" style={{ justifyContent: "center" }}>
                          <button className="btn btn-sm outline" onClick={() => openDetail(so)} title="Lihat Detail">
                            <Icon name="eye" size={14} />
                          </button>
                          {canCancelSo(so.status) && (
                            <button
                              className="btn btn-sm outline"
                              onClick={() => { setCancelModalSo(so); setCancelReason(""); }}
                              title="Batalkan SO"
                              style={{ color: "var(--red)" }}
                            >
                              <Icon name="x" size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Detail Drawer Modal */}
      {selectedSo && (
        <div className="modal-backdrop" onClick={() => setSelectedSo(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "700px", width: "95%" }}>
            <div className="modal-header row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3>Detail Sales Order: {selectedSo.orderNo}</h3>
                <span className="muted small">Dari Quotation {selectedSo.quoteNumber} ({selectedSo.clientName})</span>
              </div>
              <button className="icon-btn" onClick={() => setSelectedSo(null)}>
                <Icon name="x" size={18} />
              </button>
            </div>

            <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
              {/* Status Header */}
              <div className="row gap-md" style={{ background: "var(--bg-subtle)", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
                <div>
                  <span className="muted small block">Status Pemenuhan Gudang:</span>
                  <span className={`badge ${SO_STATUS_BADGE_TONE[selectedSo.status]}`} style={{ fontSize: "1rem", padding: "0.25rem 0.75rem" }}>
                    {SO_STATUS_LABELS[selectedSo.status]}
                  </span>
                </div>
                {selectedSo.trackingNo && (
                  <div>
                    <span className="muted small block">Nomor Resi Pengiriman:</span>
                    <span style={{ fontWeight: 600, fontFamily: "var(--mono)" }}>{selectedSo.courierCode}: {selectedSo.trackingNo}</span>
                  </div>
                )}
                {selectedSo.cancelReason && (
                  <div>
                    <span className="muted small block">Alasan Pembatalan:</span>
                    <span style={{ color: "var(--red)" }}>{selectedSo.cancelReason}</span>
                  </div>
                )}
              </div>

              {/* Items Table */}
              <h4>Barang Pesanan ({selectedSo.items.length} item)</h4>
              <table className="hk-table" style={{ marginBottom: "1rem" }}>
                <thead>
                  <tr>
                    <th>SKU / Kode</th>
                    <th>Nama Barang</th>
                    <th style={{ textAlign: "right" }}>Qty</th>
                    <th>Satuan</th>
                    <th style={{ textAlign: "right" }}>Harga Satuan</th>
                    <th style={{ textAlign: "right" }}>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedSo.items.map((it, idx) => (
                    <tr key={idx}>
                      <td><code>{it.sku}</code></td>
                      <td>{it.name}</td>
                      <td style={{ textAlign: "right" }}>{it.qty}</td>
                      <td>{it.uom}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>Rp {it.price.toLocaleString("id-ID")}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>Rp {it.subtotal.toLocaleString("id-ID")}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={5} style={{ textAlign: "right", fontWeight: 700 }}>Total</td>
                    <td style={{ textAlign: "right", fontWeight: 700, fontFamily: "var(--mono)" }}>
                      Rp {selectedSo.totalAmount.toLocaleString("id-ID")}
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* Shipping Address */}
              <h4>Tujuan Pengiriman</h4>
              <div style={{ background: "var(--bg-subtle)", padding: "0.75rem 1rem", borderRadius: "6px", marginBottom: "1rem" }}>
                <p style={{ margin: "0 0 0.25rem 0", fontWeight: 600 }}>{selectedSo.shipping.recipientName} ({selectedSo.shipping.phone})</p>
                <p style={{ margin: "0 0 0.25rem 0" }}>{selectedSo.shipping.address}</p>
                <p style={{ margin: 0 }} className="muted small">Kota: {selectedSo.shipping.city} {selectedSo.shipping.postalCode && `(${selectedSo.shipping.postalCode})`} | Kurir Pilihan: {selectedSo.shipping.courierCode || "Standar"}</p>
                {selectedSo.shipping.notes && <p style={{ margin: "0.25rem 0 0 0", fontStyle: "italic" }} className="small">Catatan: {selectedSo.shipping.notes}</p>}
              </div>

              {/* Event Timeline */}
              <h4>Riwayat Peristiwa Pemenuhan</h4>
              {loadingEvents ? (
                <div className="skeleton" style={{ height: "40px" }} />
              ) : events.length === 0 ? (
                <p className="muted small">Belum ada peristiwa tercatat.</p>
              ) : (
                <ul className="timeline-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {events.map((evt) => (
                    <li key={evt.id} style={{ padding: "0.5rem 0", borderBottom: "1px dashed var(--line)", fontSize: "0.875rem" }}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <span style={{ fontWeight: 600 }}>{evt.eventType}</span>
                        <span className="muted small">{new Date(evt.createdAt).toLocaleString("id-ID")}</span>
                      </div>
                      <div className="muted small">Oleh: {evt.actor}</div>
                      {evt.payload && Object.keys(evt.payload).length > 0 && (
                        <pre style={{ margin: "0.25rem 0 0 0", padding: "0.25rem", background: "var(--bg)", borderRadius: "4px", fontSize: "0.75rem", overflowX: "auto" }}>
                          {JSON.stringify(evt.payload, null, 2)}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="modal-footer row" style={{ justifyContent: "space-between" }}>
              {canCancelSo(selectedSo.status) ? (
                <button
                  className="btn outline"
                  style={{ color: "var(--red)" }}
                  onClick={() => { setCancelModalSo(selectedSo); setCancelReason(""); }}
                >
                  Batalkan Sales Order
                </button>
              ) : <div />}
              <button className="btn primary" onClick={() => setSelectedSo(null)}>
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Confirmation Modal */}
      {cancelModalSo && (
        <div className="modal-backdrop" onClick={() => !cancelling && setCancelModalSo(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "450px" }}>
            <div className="modal-header">
              <h3>Batalkan {cancelModalSo.orderNo}?</h3>
            </div>
            <div className="modal-body">
              <p className="small muted">
                Pembatalan akan dikirimkan ke FMS Salvator. Jika barang belum selesai dipacking di gudang, pemenuhan akan dihentikan.
              </p>
              <label className="label block small" style={{ marginTop: "0.75rem" }}>
                Alasan Pembatalan:
                <textarea
                  className="hk-input"
                  rows={3}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Contoh: Klien meminta pembatalan karena anggaran dibekukan"
                  style={{ width: "100%", marginTop: "0.25rem" }}
                  required
                />
              </label>
            </div>
            <div className="modal-footer row" style={{ justifyContent: "flex-end", gap: "0.5rem" }}>
              <button className="btn ghost" disabled={cancelling} onClick={() => setCancelModalSo(null)}>
                Batal
              </button>
              <button
                className="btn primary"
                style={{ background: "var(--red)", borderColor: "var(--red)" }}
                disabled={cancelling || !cancelReason.trim()}
                onClick={handleCancelSo}
              >
                {cancelling ? "Membatalkan…" : "Ya, Batalkan SO"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
