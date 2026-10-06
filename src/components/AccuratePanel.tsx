/* Accurate Online sync status for managers: per-entity progress, a
   "sync now" button, data-quality flags, and the explicit step that copies
   one entity's selling prices and stock into the catalog. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
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

  const load = useCallback(() => {
    api
      .get<{ entities: EntityStatus[]; catalogEntity?: Entity }>("/accurate/status")
      .then((r) => {
        setEntities(r.entities);
        if (r.catalogEntity) setCatalogEntity(r.catalogEntity);
      })
      .catch(() => setEntities(null));
    api.get<Flags>("/accurate/flags?limit=1").then(setFlags).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while a run is in progress so the counters move.
  useEffect(() => {
    if (!entities?.some((e) => e.phase !== "idle")) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [entities, load]);

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
      load();
    }
  };

  const apply = async (entity: Entity) => {
    const insertNew = window.confirm(
      `Terapkan harga jual & stok Accurate ${entity} ke katalog.\n\n` +
        "OK = juga tambahkan barang yang belum ada di katalog.\nBatal = hanya perbarui barang yang sudah ada.",
    );
    setBusy(`apply-${entity}`);
    try {
      const r = await api.post<{ changed: number; stockApplied: boolean }>("/accurate/apply", { entity, insertNew });
      toast(`${grp(r.changed)} barang diperbarui dari Accurate ${entity}${r.stockApplied ? "" : " (stok belum lengkap, tidak diubah)"}.`);
      onApplied();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
      load();
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
          </div>
        )}
      </div>
    </div>
  );
}
