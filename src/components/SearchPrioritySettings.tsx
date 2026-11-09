/* Pengaturan › Pencarian: the catalog categories (brands) that search lists first among equally good
   matches (shared/catalogSearch.ts). Order counts; nothing else is hidden. Managers and admins. */

import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { grp } from "@shared/format";

type Category = { category: string; items: number };

export function SearchPrioritySettings({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [saved, setSaved] = useState<string[]>([]);
  const [priority, setPriority] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ priority: string[]; categories: Category[] }>("/catalog/search-settings")
      .then((r) => {
        setSaved(r.priority);
        setPriority(r.priority);
        setCategories(r.categories);
      })
      .catch((e) => toast(e instanceof Error ? e.message : "Gagal memuat pengaturan pencarian.", "error"));
  }, [toast]);

  const count = (c: string) => categories.find((x) => x.category === c)?.items;
  const move = (i: number, d: -1 | 1) =>
    setPriority((p) => {
      const n = [...p];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const dirty = priority.join("\n") !== saved.join("\n");

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put<{ priority: string[] }>("/catalog/search-settings", { priority });
      setSaved(r.priority);
      setPriority(r.priority);
      toast("Urutan merek prioritas disimpan.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan.", "error");
    } finally {
      setSaving(false);
    }
  };

  const left = categories.filter((c) => !priority.includes(c.category));

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <h2>Pencarian barang</h2>
          <span className="muted small">Kategori di sini tampil paling atas di setiap pencarian barang.</span>
        </div>
      </div>
      <div className="card-body form-stack">
        <p className="field-help">
          Berlaku di Pilih dari katalog, halaman Katalog, dan Silvy. Barang kategori lain tetap ikut tampil di bawahnya.
        </p>
        {priority.length === 0 ? (
          <p className="muted">Belum ada merek prioritas.</p>
        ) : (
          <ol className="list-stack compact">
            {priority.map((c, i) => (
              <li key={c} className="row-wrap">
                <span className="grow">
                  <strong>{i + 1}. {c}</strong>
                  {count(c) !== undefined && <span className="muted small"> · {grp(count(c)!)} barang</span>}
                </span>
                {canEdit && (
                  <>
                    <button className="btn small ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Naikkan ${c}`}>
                      Naik
                    </button>
                    <button className="btn small ghost" onClick={() => move(i, 1)} disabled={i === priority.length - 1} aria-label={`Turunkan ${c}`}>
                      Turun
                    </button>
                    <button className="btn small ghost" onClick={() => setPriority((p) => p.filter((x) => x !== c))} aria-label={`Hapus ${c}`}>
                      Hapus
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
        {canEdit && (
          <div className="inline-form">
            <label className="field">
              <span>Tambah kategori</span>
              <select className="select" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Pilih kategori…</option>
                {left.map((c) => (
                  <option key={c.category} value={c.category}>
                    {c.category} ({grp(c.items)})
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              disabled={!adding || priority.length >= 12}
              onClick={() => {
                setPriority((p) => [...p, adding]);
                setAdding("");
              }}
            >
              Tambah
            </button>
            <span className="grow" />
            <button className="btn primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Menyimpan…" : "Simpan urutan"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
