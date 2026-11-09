import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Icon } from "../components/Icon";
import { ConfirmModal, Modal } from "../components/Modal";
import { Menu, type MenuEntry } from "../components/Menu";
import { ImportDialog } from "../components/ImportDialog";
import { Thumb } from "../components/Thumb";
import { ItemImageEditor } from "../components/ItemImageEditor";
import { BulkImageUpload } from "../components/BulkImageUpload";
import { AccuratePanel } from "../components/AccuratePanel";
import { PendingItemsPanel } from "../components/PendingItemsPanel";
import { fmtDateTime, grp } from "@shared/format";
import type { CatalogItem, UnitFactor } from "@shared/types";
import { cleanUnits, sameUom } from "@shared/uom";

/** COGS = harga pembelian terakhir: an import leaves the COGS of purchased items alone (server/worker/routes/catalog.ts). */
const keptNote = (n = 0) =>
  n > 0 ? ` COGS ${grp(n)} barang tidak diubah karena memakai harga pembelian terakhir dari Accurate.` : "";

interface Stats {
  total: number;
  priced: number;
  withList: number;
  withImage: number;
  updated: string | null;
}

const EMPTY_ITEM = {
  code: "", name: "", uom: "Pcs", cogs: 0, list_price: 0, category: "", units: [] as UnitFactor[],
};
type EditingItem = typeof EMPTY_ITEM & { id?: number };

export function CatalogPage() {
  const toast = useToast();
  const { can } = useAuth();
  // Staff receive no COGS and can't sort by it either (PE-1).
  const seeCosts = can("view_costs");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stockAsOf, setStockAsOf] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  // "" = by relevance while searching (shared/catalogSearch.ts), by name otherwise; a column header sorts.
  const [sortBy, setSortBy] = useState<"" | "name" | "stock" | "cogs" | "list_price">("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [imageFilter, setImageFilter] = useState<"all" | "with" | "without">("all");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<null | "inventory" | "master" | "full" | "confirmFull" | "fullMerge" | "images">(null);
  const [editing, setEditing] = useState<EditingItem | null>(null);
  const [uomOptions, setUomOptions] = useState<string[]>([]);
  const [addingUom, setAddingUom] = useState(false);
  const [newUom, setNewUom] = useState("");
  // The base unit when the form opened: ratios are relative to it.
  const [baseAtOpen, setBaseAtOpen] = useState("");
  const PAGE = 50;

  /** Manager confirms a COGS that moved >50% from its reference is real (shared/cogsCheck.ts). */
  const verifyCogs = async (id: number) => {
    try {
      await api.post(`/catalog/${id}/verify-cogs`);
      toast("COGS ditandai sudah dicek.", "success");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menandai COGS.", "error");
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      q: query.trim(),
      limit: String(PAGE),
      offset: String(page * PAGE),
      ...(sortBy ? { sortBy, sortDir } : {}),
      ...(imageFilter === "all" ? {} : { image: imageFilter }),
    });
    api
      .get<{ items: CatalogItem[]; total: number; stockAsOf: string | null; suggestion?: string | null; partial?: boolean }>(`/catalog?${params}`)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
        setStockAsOf(r.stockAsOf);
        setSuggestion(r.suggestion ?? null);
        setPartial(!!r.partial);
      })
      .catch((e) => toast(e.message, "error"))
      .finally(() => setLoading(false));
    api.get<{ stats: Stats }>("/catalog/stats").then((r) => setStats(r.stats)).catch(() => undefined);
  }, [query, page, sortBy, sortDir, imageFilter, toast]);

  const openEditing = (item: EditingItem) => {
    setAddingUom(false);
    setNewUom("");
    setBaseAtOpen(item.uom);
    setEditing(item);
  };
  const closeEditing = () => {
    setAddingUom(false);
    setNewUom("");
    setEditing(null);
  };

  const toggleSort = (field: "name" | "stock" | "cogs" | "list_price") => {
    setPage(0);
    setSortDir(sortBy === field && sortDir === "asc" ? "desc" : "asc");
    setSortBy(field);
  };

  useEffect(() => {
    const t = setTimeout(load, 220);
    return () => clearTimeout(t);
  }, [load]);

  const loadUom = useCallback(() => {
    api
      .get<{ options: { id: number; name: string }[] }>("/catalog/uom")
      .then((r) => setUomOptions(r.options.map((o) => o.name)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadUom();
  }, [loadUom]);

  const pages = Math.ceil(total / PAGE);
  const filtered = query.trim() !== "" || imageFilter !== "all";

  const importMenu: MenuEntry[] = [
    { label: "Nilai Persediaan", hint: "COGS dari Accurate", onSelect: () => setModal("inventory") },
    { label: "Daftar Barang dan Jasa", hint: "Harga jual acuan", onSelect: () => setModal("master") },
    { label: "Katalog lengkap (gabung)", hint: "Template katalog, barang lama tetap", onSelect: () => setModal("fullMerge") },
    "divider",
    {
      label: "Unduh template katalog",
      onSelect: () => void import("../import/parsers").then((m) => m.downloadFullCatalogTemplate()),
    },
    ...(can("delete_catalog")
      ? ([
          "divider",
          {
            label: "Ganti seluruh katalog…", hint: "Hapus semua barang, isi dari file", danger: true,
            onSelect: () => setModal("confirmFull"),
          },
        ] satisfies MenuEntry[])
      : []),
  ];

  const sortHead = (field: "stock" | "cogs" | "list_price", label: string) => {
    const on = sortBy === field;
    return (
      <th aria-sort={on ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
        <button type="button" className={`th-sort${on ? " on" : ""}`} onClick={() => toggleSort(field)}>
          {label} <Icon name={on ? `sort-${sortDir}` : "sort"} size={14} />
        </button>
      </th>
    );
  };

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Katalog barang</h1>
          <p>
            Harga pokok = harga pembelian terakhir di Accurate (faktur pembelian); barang yang belum
            pernah dibeli memakai laporan Nilai Persediaan. Harga jual acuan dari Daftar Barang dan Jasa.
          </p>
        </div>
        {can("import_catalog") && (
          <div className="row-wrap">
            <Menu label="Impor" items={importMenu} />
            {can("edit_catalog") && (
              <button className="btn" onClick={() => setModal("images")}>
                Unggah gambar massal
              </button>
            )}
            <button className="btn primary" onClick={() => openEditing({ ...EMPTY_ITEM })}>
              Tambah barang
            </button>
          </div>
        )}
      </div>

      {stats && (
        <div className="kpi-grid">
          <div className="kpi">
            <div className="label">Item di katalog</div>
            <div className="value num">{grp(stats.total)}</div>
          </div>
          <div className="kpi">
            <div className="label">Sudah bergambar</div>
            <div className="value num">{grp(stats.withImage)}</div>
            <div className="foot">dari {grp(stats.total)} item</div>
          </div>
          <div className="kpi">
            <div className="label">Punya harga pokok</div>
            <div className="value num">{grp(stats.priced)}</div>
            <div className="foot">
              {stats.total ? Math.round((stats.priced / stats.total) * 100) : 0}% dari katalog
            </div>
          </div>
          <div className="kpi">
            <div className="label">Punya harga jual acuan</div>
            <div className="value num">{grp(stats.withList)}</div>
          </div>
          <div className="kpi">
            <div className="label">Terakhir diperbarui</div>
            <div className="value text">
              {stats.updated ? fmtDateTime(stats.updated) : "—"}
            </div>
          </div>
        </div>
      )}

      {can("edit_catalog") && <PendingItemsPanel />}

      {can("import_catalog") && <AccuratePanel onApplied={load} />}


      {stats && stats.total > 0 && stats.priced / stats.total < 0.6 && (
        <p className="notice warn">
          Hanya {Math.round((stats.priced / stats.total) * 100)}%
          item punya harga pokok. Barang yang belum pernah dibeli (tanpa faktur pembelian di Accurate)
          tidak punya harga pembelian terakhir — isi manual atau lewat impor Nilai Persediaan untuk item
          yang benar-benar dijual.
        </p>
      )}

      <div className="card">
        <div className="toolbar">
          <input
            className="input toolbar-search"
            type="search"
            placeholder="Cari nama atau kode barang"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            aria-label="Cari katalog"
          />
          <select
            className="select toolbar-select"
            value={imageFilter}
            onChange={(e) => {
              setImageFilter(e.target.value as "all" | "with" | "without");
              setPage(0);
            }}
            aria-label="Filter gambar"
          >
            <option value="all">Gambar: semua</option>
            <option value="with">Sudah ada gambar</option>
            <option value="without">Belum ada gambar</option>
          </select>
          <span className="grow" />
          <span className="muted small">
            {grp(total)} item cocok{stockAsOf && ` · stok Accurate per ${fmtDateTime(stockAsOf)}`}
          </span>
        </div>
        {partial && items.length > 0 && (
          <p className="note pad">Tidak ada barang yang cocok dengan semua kata. Ini yang paling mendekati.</p>
        )}
        {suggestion && (
          <p className="note pad">
            Mungkin maksud Anda:{" "}
            <button
              className="link-btn"
              onClick={() => {
                setQuery(suggestion);
                setPage(0);
              }}
            >
              {suggestion}
            </button>
          </p>
        )}

        {loading ? (
          <div className="card-body skeleton-list" role="status" aria-label="Memuat katalog…">
            {[0, 1, 2, 3, 4].map((i) => <span key={i} className="skeleton" />)}
          </div>
        ) : items.length === 0 && filtered ? (
          <div className="card-body empty">
            <h3>Tidak ada barang yang cocok</h3>
            <p>Coba kata lain, atau ubah filter gambar.</p>
            <button className="btn" onClick={() => { setQuery(""); setImageFilter("all"); setPage(0); }}>
              Hapus pencarian
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="card-body empty">
            <h3>Katalog masih kosong</h3>
            <p>
              Impor laporan Nilai Persediaan untuk harga pokok, lalu Daftar Barang dan Jasa untuk
              harga jual acuan.
            </p>
            {can("import_catalog") && (
              <button className="btn primary" onClick={() => setModal("inventory")}>
                Impor Nilai Persediaan
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="table-wrap flush">
              <table className="table stack">
                <thead>
                  <tr>
                    <th className="l">Kode</th>
                    <th className="l">Nama barang</th>
                    <th className="l">Kategori</th>
                    <th className="l">Satuan</th>
                    <th className="l">Konversi</th>
                    {seeCosts && sortHead("cogs", "COGS")}
                    {sortHead("list_price", "Harga jual")}
                    {sortHead("stock", "Stok")}
                    {can("edit_catalog") && <th aria-label="Aksi" />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className={(seeCosts ? item.cogs > 0 : !item.cogs_problem) ? "" : "flagged"}>
                      <td className="l muted num" data-label="Kode">{item.code}</td>
                      <td className="l stack-title">
                        <div className="with-thumb">
                          <Thumb src={item.image} alt={item.name} />
                          <span className="grow">{item.name}</span>
                        </div>
                        {item.cogs_problem && (!seeCosts || item.cogs > 0) && (
                          <div className="cell-problem">
                            <span>{item.cogs_problem}. Tidak bisa dipakai di penawaran.</span>
                            {can("edit_catalog") && /COGS acuan/.test(item.cogs_problem) && (
                              <button className="btn small" onClick={() => void verifyCogs(item.id)}>
                                COGS ini benar
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="l muted small" data-label="Kategori">{item.category || "—"}</td>
                      <td className="l muted" data-label="Satuan">{item.uom}</td>
                      <td className="l" data-label="Konversi">
                        {item.units?.length ? (
                          <div className="badge-row">
                            {item.units.map((u) => (
                              <span key={u.uom} className="badge grey num">
                                1 {u.uom} = {grp(u.factor)} {item.uom}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      {seeCosts && (
                        <td className="num" data-label="COGS">
                          {item.cogs > 0 ? grp(item.cogs) : <span className="badge amber">kosong</span>}
                        </td>
                      )}
                      <td className="num" data-label="Harga jual">{item.list_price > 0 ? grp(item.list_price) : "—"}</td>
                      <td className="num muted" data-label="Stok">{grp(item.stock)}</td>
                      {can("edit_catalog") && (
                        <td className="stack-action">
                          <button className="btn small ghost" onClick={() => openEditing({ ...item, units: item.units ?? [] })}>Ubah</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="table-foot">
                <span className="muted small num">
                  Menampilkan {grp(page * PAGE + 1)}–{grp(Math.min(total, (page + 1) * PAGE))} dari {grp(total)}
                </span>
                <span className="grow" />
                <button className="btn small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Sebelumnya
                </button>
                <label className="muted small">
                  Halaman{" "}
                  <select
                    className="select inline"
                    value={page}
                    onChange={(e) => setPage(Number(e.target.value))}
                    aria-label="Pilih halaman"
                  >
                    {Array.from({ length: pages }, (_, i) => (
                      <option key={i} value={i}>{i + 1}</option>
                    ))}
                  </select>{" "}
                  dari {pages}
                </label>
                <button className="btn small" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                  Berikutnya
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {modal === "images" && <BulkImageUpload onClose={() => setModal(null)} onDone={load} />}

      {modal === "inventory" && (
        <ImportDialog
          title="Impor laporan Nilai Persediaan"
          description='Export Accurate "Nilai Persediaan". COGS per unit dihitung dari nilai barang masuk dibagi kuantitasnya. Barang yang punya harga pembelian terakhir dari Accurate tidak diubah COGS-nya.'
          onClose={() => {
            setModal(null);
            load();
          }}
          onFile={async (file) => {
            const { parseInventory } = await import("../import/parsers");
            const { rows, report } = await parseInventory(file);
            const r = await api.post<{ inserted: number; updated: number; cogsFromPurchases?: number }>("/catalog/import", {
              rows,
              source: file.name,
              mode: "merge",
            });
            return {
              report,
              summary: `${report.count} barang terbaca. ${r.inserted} baru ditambahkan, ${r.updated} diperbarui.${keptNote(r.cogsFromPurchases)}`,
            };
          }}
        />
      )}

      {modal === "confirmFull" && (
        <ConfirmModal
          title="Ganti seluruh katalog?"
          message={
            <>
              Barang yang tidak ada di file akan dihapus dari katalog
              {stats ? ` (sekarang ${grp(stats.total)} barang)` : ""}; barang yang ada di file diperbarui.
              Tindakan ini tidak bisa dibatalkan.
            </>
          }
          confirmLabel="Ya, pilih file"
          onConfirm={() => setModal("full")}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "full" && (
        <ImportDialog
          title="Impor katalog lengkap"
          description={
            <>
              <strong className="text-err">
                Ini menghapus seluruh isi katalog lalu menggantinya dengan isi file ini.
              </strong>{" "}
              Pakai template "Unduh template katalog". Kolom Kode Barang dan Nama Barang wajib diisi.
              Barang baru dari Accurate berhenti masuk otomatis sampai "Terapkan ke katalog" dijawab OK.
            </>
          }
          onClose={() => {
            setModal(null);
            load();
          }}
          onFile={async (file) => {
            const { parseFullCatalog } = await import("../import/parsers");
            const { rows, report } = await parseFullCatalog(file);
            const r = await api.post<{ inserted: number; updated: number; total: number; removed: number }>("/catalog/import", {
              rows,
              source: file.name,
              mode: "replace",
            });
            return {
              report,
              summary: `Katalog diganti. ${r.total} barang dari file, ${r.inserted} ditambahkan, ${r.removed} dihapus.`,
            };
          }}
        />
      )}

      {modal === "fullMerge" && (
        <ImportDialog
          title="Impor katalog lengkap (gabung)"
          description='Sama seperti template katalog lengkap (Kode Barang, Nama Barang, COGS, Harga Jual sekaligus), tapi digabung ke katalog yang ada — barang lama tidak dihapus. Kode yang sudah ada diperbarui, kode baru ditambahkan.'
          onClose={() => {
            setModal(null);
            load();
          }}
          onFile={async (file) => {
            const { parseFullCatalog } = await import("../import/parsers");
            const { rows, report } = await parseFullCatalog(file);
            const r = await api.post<{ inserted: number; updated: number; total: number; cogsFromPurchases?: number }>("/catalog/import", {
              rows,
              source: file.name,
              mode: "merge",
            });
            return {
              report,
              summary: `${r.total} barang dari file: ${r.inserted} ditambahkan, ${r.updated} diperbarui.${keptNote(r.cogsFromPurchases)}`,
            };
          }}
        />
      )}

      {modal === "master" && (
        <ImportDialog
          title="Impor Daftar Barang dan Jasa"
          description='Export Accurate "Daftar Barang dan Jasa". Harga jual default dipakai sebagai plafon awal saat item ditambahkan ke quotation.'
          onClose={() => {
            setModal(null);
            load();
          }}
          onFile={async (file) => {
            const { parseItemMaster } = await import("../import/parsers");
            const { rows, report } = await parseItemMaster(file);
            const r = await api.post<{ inserted: number; updated: number }>("/catalog/import", {
              rows,
              source: file.name,
              mode: "merge",
            });
            return {
              report,
              summary: `${report.count} barang terbaca. ${r.inserted} baru ditambahkan, ${r.updated} diperbarui.`,
            };
          }}
        />
      )}

      {editing && (
        <Modal
          title={editing.id ? "Ubah data barang" : "Tambah barang"}
          sub={editing.id ? editing.code : undefined}
          onClose={closeEditing}
          footer={
            <>
              <button className="btn ghost" onClick={closeEditing}>Batal</button>
              <button
                className="btn primary"
                disabled={!editing.name.trim() || (!editing.id && !editing.code.trim())}
                onClick={async () => {
                  try {
                    if (editing.id) {
                      await api.put(`/catalog/${editing.id}`, {
                        name: editing.name,
                        uom: editing.uom,
                        cogs: Number(editing.cogs),
                        list_price: Number(editing.list_price),
                        category: editing.category,
                        units: cleanUnits(editing.uom, editing.units),
                      });
                      toast("Barang diperbarui.", "success");
                    } else {
                      await api.post("/catalog/import", {
                        rows: [
                          {
                            code: editing.code.trim(),
                            name: editing.name,
                            uom: editing.uom,
                            cogs: Number(editing.cogs),
                            list_price: Number(editing.list_price),
                            category: editing.category,
                            units: cleanUnits(editing.uom, editing.units),
                          },
                        ],
                        source: "manual",
                        mode: "merge",
                      });
                      toast("Barang ditambahkan.", "success");
                    }
                    closeEditing();
                    load();
                  } catch (e) {
                    toast(e instanceof Error ? e.message : "Gagal menyimpan.", "error");
                  }
                }}
              >
                Simpan
              </button>
            </>
          }
        >
          <div className="form-stack">
            {!editing.id && (
              <label className="field">
                <span>Kode barang</span>
                <input
                  className="input"
                  value={editing.code}
                  onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                  placeholder="Kode unik, misal ATK-0001"
                />
              </label>
            )}
            <label className="field">
              <span>Nama barang</span>
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            {editing.id && can("edit_catalog") && (
              <ItemImageEditor
                code={editing.code}
                image={items.find((i) => i.id === editing.id)?.image ?? null}
                onChanged={load}
              />
            )}
            <div className="field-grid">
              <label className="field">
                <span>Satuan dasar</span>
                {addingUom ? (
                  <div className="row-wrap">
                    <input
                      className="input"
                      autoFocus
                      placeholder="Satuan baru, misal Dus"
                      value={newUom}
                      onChange={(e) => setNewUom(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn small"
                      disabled={!newUom.trim()}
                      onClick={async () => {
                        try {
                          const name = newUom.trim();
                          await api.post("/catalog/uom", { name });
                          loadUom();
                          setEditing({ ...editing, uom: name });
                          setNewUom("");
                          setAddingUom(false);
                        } catch (e) {
                          toast(e instanceof Error ? e.message : "Gagal menambah satuan.", "error");
                        }
                      }}
                    >
                      Tambah
                    </button>
                    <button type="button" className="btn small ghost" onClick={() => { setAddingUom(false); setNewUom(""); }}>
                      Batal
                    </button>
                  </div>
                ) : (
                  <select
                    className="select"
                    value={editing.uom}
                    onChange={(e) => {
                      if (e.target.value === "__new__") { setAddingUom(true); return; }
                      setEditing({ ...editing, uom: e.target.value });
                    }}
                  >
                    {!uomOptions.includes(editing.uom) && editing.uom && (
                      <option value={editing.uom}>{editing.uom}</option>
                    )}
                    {uomOptions.map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                    <option value="__new__">+ Tambah satuan baru…</option>
                  </select>
                )}
              </label>
              <label className="field">
                <span>COGS per {editing.uom || "satuan"}</span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={editing.cogs}
                  onChange={(e) => setEditing({ ...editing, cogs: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>Harga jual acuan per {editing.uom || "satuan"}</span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={editing.list_price}
                  onChange={(e) => setEditing({ ...editing, list_price: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>Kategori</span>
                <input
                  className="input"
                  value={editing.category}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                />
              </label>
            </div>
            {!!editing.id && editing.units.length > 0 && !sameUom(editing.uom, baseAtOpen) && (
              <p className="notice warn">
                Satuan dasar diganti dari {baseAtOpen} ke {editing.uom}. Isi konversi di bawah sekarang
                dihitung dalam {editing.uom}, cek ulang angkanya sebelum simpan.
              </p>
            )}
            <UnitsEditor
              baseUom={editing.uom}
              units={editing.units}
              options={uomOptions}
              onChange={(units) => setEditing({ ...editing, units })}
            />
          </div>
        </Modal>
      )}
    </main>
  );
}

/* Extra units for one item and how many base units each holds, laid out as
   a small data-entry table (same cells as the quote's items table). The
   quote editor uses these to rescale COGS/RRP when a line's unit changes. */
function UnitsEditor({
  baseUom,
  units,
  options,
  onChange,
}: {
  baseUom: string;
  units: UnitFactor[];
  options: string[];
  onChange: (units: UnitFactor[]) => void;
}) {
  const set = (i: number, patch: Partial<UnitFactor>) =>
    onChange(units.map((u, k) => (k === i ? { ...u, ...patch } : u)));
  const free = (keep?: string) =>
    options.filter(
      (o) => (keep && sameUom(o, keep)) || (!sameUom(o, baseUom) && !units.some((u) => sameUom(u.uom, o))),
    );
  const unused = free();
  const base = baseUom || "satuan dasar";
  return (
    <div className="field">
      <span>Konversi satuan</span>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="l">Satuan</th>
              <th>Isi ({base})</th>
              <th aria-label="Aksi" />
            </tr>
          </thead>
          <tbody>
            {units.length === 0 ? (
              <tr>
                <td className="l muted small" colSpan={3}>
                  Belum ada. Tanpa konversi, mengganti satuan di quotation tidak mengubah COGS/RRP.
                </td>
              </tr>
            ) : (
              units.map((u, i) => (
                <tr key={i}>
                  <td className="l">
                    <select
                      className="cell"
                      value={u.uom}
                      onChange={(e) => set(i, { uom: e.target.value })}
                      aria-label={`Satuan konversi ${i + 1}`}
                    >
                      {!options.some((o) => sameUom(o, u.uom)) && <option value={u.uom}>{u.uom}</option>}
                      {free(u.uom).map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="cell"
                      type="number"
                      min="0"
                      step="any"
                      value={u.factor || ""}
                      placeholder="0"
                      onChange={(e) => set(i, { factor: Number(e.target.value) })}
                      aria-label={`Rasio ${u.uom}`}
                    />
                  </td>
                  <td className="col-icon">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onChange(units.filter((_, k) => k !== i))}
                      aria-label={`Hapus satuan ${u.uom}`}
                      title="Hapus"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="row-between">
        <span className="muted small">
          {units[0]?.factor > 0
            ? `Contoh: 1 ${units[0].uom} = ${units[0].factor} ${base}.`
            : `Isi = berapa ${base} dalam 1 satuan itu.`}
        </span>
        {unused.length > 0 && units.length < 10 && (
          <button
            type="button"
            className="btn small"
            onClick={() => onChange([...units, { uom: unused[0], factor: 0 }])}
          >
            Tambah satuan
          </button>
        )}
      </div>
    </div>
  );
}
