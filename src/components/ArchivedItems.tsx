import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { fmtDateTime, grp } from "@shared/format";
import type { ArchivedItem } from "../../shared/catalogArchive";

/* Arsip barang: barang duplikat yang kalah di ACC Duplikat. Disembunyikan dari Katalog dan pencarian, tetap ada
 * di database (sinkron Accurate akan memasukkannya lagi kalau dihapus). Admin bisa memulihkan, dan menandai
 * "sudah dinonaktifkan di Accurate" (API Accurate tidak bisa menonaktifkan barang; itu dikerjakan manusia). */

/** Status "Nonaktifkan di Accurate" satu barang arsip, dengan tombol tanda manual untuk yang berhak. */
export function AccurateOffTag({ item, onChanged }: { item: ArchivedItem; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function mark() {
    setBusy(true);
    try {
      await api.post(`/catalog/${item.id}/accurate-off`, {});
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan tanda.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className={`badge ${item.accurate_status === "sudah" ? "green" : "amber"}`}>
        Nonaktifkan di Accurate: {item.accurate_status}
      </span>
      {item.accurate_status === "belum" && can("review_catalog_drafts") && (
        <button className="btn small" style={{ marginLeft: 6 }} disabled={busy} onClick={() => void mark()}>
          Sudah dinonaktifkan
        </button>
      )}
    </>
  );
}

export function ArchivedItems({ onClose, onRestored }: { onClose: () => void; onRestored?: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ArchivedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api
      .get<{ items: ArchivedItem[]; total: number }>(`/catalog/archived?q=${encodeURIComponent(query)}`)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => toast(e instanceof Error ? e.message : "Gagal memuat arsip.", "error"));
  }, [query, toast]);
  useEffect(load, [load]);

  async function restore(item: ArchivedItem) {
    setBusy(item.id);
    try {
      await api.post(`/catalog/${item.id}/restore`, {});
      toast(`${item.name} dipulihkan ke katalog.`, "success");
      load();
      onRestored?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal memulihkan.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card catalog-list" data-testid="catalog-archive">
      <div className="toolbar">
        <input
          className="input toolbar-search"
          type="search"
          placeholder="Cari di arsip: nama atau kode"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Cari arsip"
        />
        <span className="grow" />
        <span className="muted small">{grp(total)} barang di arsip</span>
        <button className="btn" onClick={onClose}>Kembali ke katalog</button>
      </div>
      {items.length === 0 ? (
        <div className="card-body empty">
          <h3>Arsip kosong</h3>
          <p>Barang masuk arsip saat Admin meng-ACC laporan Duplikat. Barang yang tidak dipakai diarsipkan, tidak dihapus.</p>
        </div>
      ) : (
        <ul className="fix-list">
          {items.map((i) => (
            <li key={i.id} className="fix-row">
              <div className="fix-main">
                <strong>{i.name}</strong> <span className="muted num">· {i.code || "tanpa kode"}</span>
                <div className="muted small">
                  {i.archived_note || "Diarsipkan"} · {i.archived_by_name ?? "—"}, {fmtDateTime(i.archived_at)}
                </div>
                <div className="badge-row">
                  <span className="badge grey">Diarsip</span>
                  <AccurateOffTag item={i} onChanged={load} />
                  {i.accurate_off_at && (
                    <span className="muted small">ditandai {i.accurate_off_by_name ?? "—"}, {fmtDateTime(i.accurate_off_at)}</span>
                  )}
                </div>
              </div>
              {can("review_catalog_drafts") && (
                <div className="fix-actions">
                  <button className="btn small" disabled={busy === i.id} onClick={() => void restore(i)}>Pulihkan</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
