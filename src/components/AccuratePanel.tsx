/* Accurate Online sync status for managers: per-entity progress, a
   "sync now" button, data-quality flags, and the explicit step that copies
   one entity's selling prices and stock into the catalog. */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { AccurateReconcile } from "./AccurateReconcile";
import { fmtDateTime, grp } from "@shared/format";

type Entity = "CV" | "PT";

interface EntityStatus {
  entity: Entity;
  configured: boolean;
  dbAlias: string | null;
  phase: "idle" | "items" | "warehouses" | "stock";
  itemsSeen: number;
  stockRows: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  items: number;
  priced: number;
  stock: number;
  warehouses: number;
}

interface Flags {
  counts: {
    negative_stock: number;
    overlapping_codes: number;
    cross_entity_mismatch: number;
    same_name_different_code: number;
    no_selling_price: number;
  };
}

const STATUS_POLL_MS = 20_000;

const PHASE: Record<EntityStatus["phase"], string> = {
  idle: "Siap",
  items: "Menarik barang",
  warehouses: "Menarik gudang",
  stock: "Menarik stok",
};

export function AccuratePanel({ onApplied }: { onApplied: () => void }) {
  const toast = useToast();
  const [entities, setEntities] = useState<EntityStatus[] | null>(null);
  const [catalogEntity, setCatalogEntity] = useState<Entity>("PT");
  const [flags, setFlags] = useState<Flags | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // `fresh` skips the server's short cache; use it only right after an action that changed the data.
  const loadStatus = useCallback((fresh = false) => {
    api
      .get<{ entities: EntityStatus[]; catalogEntity?: Entity }>(`/accurate/status${fresh ? "?fresh=1" : ""}`)
      .then((r) => {
        setEntities(r.entities);
        if (r.catalogEntity) setCatalogEntity(r.catalogEntity);
      })
      .catch(() => setEntities(null));
  }, []);
  const loadFlags = useCallback((fresh = false) => {
    api.get<Flags>(`/accurate/flags?limit=1${fresh ? "&fresh=1" : ""}`).then(setFlags).catch(() => undefined);
  }, []);
  const load = useCallback(
    (fresh = false) => {
      loadStatus(fresh);
      loadFlags(fresh);
    },
    [loadStatus, loadFlags],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Poll the (cheap) status while a run is in progress so the counters move, and only while this tab is
  // visible. The data-quality flags are heavy aggregates over the whole catalogue: they are loaded on
  // open, after an action, and once when a run finishes, never on a timer. A panel left open on a
  // second screen used to read millions of rows a day and exhaust D1's daily allowance.
  const running = !!entities?.some((e) => e.phase !== "idle");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (!document.hidden) loadStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [running, loadStatus]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) load(true);
    wasRunning.current = running;
  }, [running, load]);

  if (!entities) return null;
  const configured = entities.filter((e) => e.configured);

  const sync = async (entity: Entity) => {
    setBusy(`sync-${entity}`);
    try {
      const r = await api.post<{ results: { outcome: string; error?: string }[] }>("/accurate/sync", {
        entity,
        restart: entities.find((e) => e.entity === entity)?.phase === "idle",
      });
      const res = r.results[0];
      if (res?.outcome === "error") toast(res.error ?? "Sinkron gagal.", "error");
      else toast(res?.outcome === "finished" ? "Sinkron selesai." : "Sinkron berjalan, dilanjutkan otomatis tiap 5 menit.");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
      load(true);
    }
  };

  const apply = async (entity: Entity) => {
    const insertNew = window.confirm(
      `Terapkan harga jual & stok Accurate ${entity} ke katalog.\n\n` +
        "OK = juga tambahkan barang yang belum ada di katalog.\nBatal = hanya perbarui barang yang sudah ada.",
    );
    setBusy(`apply-${entity}`);
    try {
      const r = await api.post<{ changed: number; stockApplied: boolean; unitMismatch: string[] }>("/accurate/apply", { entity, insertNew });
      toast(`${grp(r.changed)} barang diperbarui dari Accurate ${entity}${r.stockApplied ? "" : " (stok belum lengkap, tidak diubah)"}.`);
      // Items whose base unit changed in Accurate but already have a COGS keep
      // their catalog unit, price and stock until a manager reconciles them.
      if (r.unitMismatch.length) {
        const shown = r.unitMismatch.slice(0, 5).join(", ") + (r.unitMismatch.length > 5 ? ", …" : "");
        toast(`${r.unitMismatch.length} barang satuannya beda di Accurate dan sudah punya COGS, jadi tidak diubah: ${shown}. Cek satuan dan COGS-nya.`, "error");
      }
      onApplied();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
      load(true);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h3>Sinkron Accurate</h3>
        <span className="muted small">Hanya membaca dari Accurate. COGS tetap dari laporan Nilai Persediaan.</span>
      </div>
      <div className="card-body">
        {configured.length === 0 ? (
          <p className="notice warn">
            <Icon name="alert" size={14} /> Token Accurate belum dipasang di server. Admin perlu menjalankan{" "}
            <code>wrangler secret put ACCURATE_SIGNATURE_SECRET</code> dan <code>ACCURATE_TOKEN_CV</code> /{" "}
            <code>ACCURATE_TOKEN_PT</code>.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {configured.map((e) => (
              <div key={e.entity} className="row-wrap" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{e.entity}</strong>
                  {e.dbAlias && <span className="muted small"> · {e.dbAlias}</span>}{" "}
                  <span className={`badge ${e.lastError ? "red" : e.phase === "idle" ? "green" : "blue"}`}>
                    {e.lastError ? "Error" : PHASE[e.phase]}
                  </span>
                  <div className="muted small">
                    {grp(e.items)} barang ({grp(e.priced)} berharga jual) · {grp(e.warehouses)} gudang ·{" "}
                    {grp(e.stock)} baris stok · terakhir lengkap{" "}
                    {e.lastSuccessAt ? fmtDateTime(e.lastSuccessAt) : "belum pernah"}
                    {e.phase !== "idle" && ` · berjalan: ${grp(e.itemsSeen)} barang, ${grp(e.stockRows)} stok`}
                  </div>
                  {e.lastError && <div className="small" style={{ color: "var(--danger)" }}>{e.lastError}</div>}
                </div>
                <div className="row-wrap">
                  <button className="btn small ghost" disabled={!!busy} onClick={() => sync(e.entity)}>
                    <Icon name="history" size={13} /> {e.phase === "idle" ? "Sinkron sekarang" : "Lanjutkan"}
                  </button>
                  {e.entity === catalogEntity ? (
                    <button className="btn small" disabled={!!busy || e.items === 0} onClick={() => apply(e.entity)}>
                      <Icon name="download" size={13} /> Terapkan ke katalog
                    </button>
                  ) : (
                    <span className="muted small">Untuk pengecekan saja</span>
                  )}
                </div>
              </div>
            ))}
            {flags && (
              <div className="row-wrap small">
                <span className="badge red">{grp(flags.counts.negative_stock)} stok minus</span>
                <span className="badge amber">
                  {grp(flags.counts.cross_entity_mismatch)} / {grp(flags.counts.overlapping_codes)} kode CV–PT beda nama/harga
                </span>
                <span className="badge amber">{grp(flags.counts.same_name_different_code)} nama sama, kode beda</span>
                <span className="badge grey">{grp(flags.counts.no_selling_price)} tanpa harga jual</span>
              </div>
            )}
            {configured.some((e) => e.entity === catalogEntity) && <AccurateReconcile />}
          </div>
        )}
      </div>
    </div>
  );
}
