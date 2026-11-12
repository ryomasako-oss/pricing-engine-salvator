/* Adds priced catalogue items to a quote. Cost comes from the imported
   inventory, and the ceiling defaults to the item master's list price. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { fmtDateTime, grp } from "@shared/format";
import { normalizeCode } from "@shared/duplicates";
import type { CatalogItem, QuoteItem } from "@shared/types";
import { lineFromCatalog } from "@shared/match";
import { uomChoices, uomWarning } from "@shared/uom";
import { Modal } from "./Modal";
import { UomCell } from "./UomCell";
import { Thumb } from "./Thumb";
import { NewItemForm } from "./NewItemForm";

const PAGE = 50;

export function CatalogPicker({
  onClose,
  onAdd,
  existingCodes,
}: {
  onClose: () => void;
  /** Receives the picks; the parent closes (or replaces) this dialog. */
  onAdd: (items: QuoteItem[]) => void;
  /** Codes already on the quote, normalized with `normalizeCode`. */
  existingCodes: Set<string>;
}) {
  // Staff don't receive COGS (PE-1): the column is left out.
  const seeCosts = useAuth().can("view_costs");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stockAsOf, setStockAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Typo correction and "no item has every word" from the search (shared/catalogSearch.ts).
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [byMeaning, setByMeaning] = useState(0);
  const seq = useRef(0);
  const [chosen, setChosen] = useState<Record<number, number>>({});
  // Items stay picked across searches, but a later search replaces `items` and
  // drops earlier matches from it. Cache the full row here so add() doesn't
  // need the item to still be in the current search results.
  const [pickedItems, setPickedItems] = useState<Record<number, CatalogItem>>({});
  // What was typed when each item was picked: the search learns it (POST /catalog/search-picks).
  const [pickedQuery, setPickedQuery] = useState<Record<number, string>>({});
  // Off by default (Ryoma, 9 Nov: "hasil masih sedikit"): half the catalog has no COGS yet, and such
  // an item goes on the quote held until a manager checks it, so it is safe to show.
  const [onlyPriced, setOnlyPriced] = useState(false);
  // Managed satuan list. A row's UOM can be switched at pick time (e.g. an
  // item mastered in Pcs but ordered per Lusin); COGS/RRP are rescaled with
  // the item's ratio, and the override only applies to the quote line, never
  // to the catalog master.
  const [uomOptions, setUomOptions] = useState<string[]>([]);
  const [uomOverride, setUomOverride] = useState<Record<number, string>>({});
  // "Barang baru": an item that isn't in Accurate yet (components/NewItemForm.tsx).
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .get<{ options: { id: number; name: string }[] }>("/catalog/uom")
      .then((r) => setUomOptions(r.options.map((o) => o.name)))
      .catch(() => setUomOptions([]));
  }, []);

  type Page = { items: CatalogItem[]; total: number; stockAsOf: string | null; suggestion?: string | null; partial?: boolean; byMeaning?: number };
  const params = useCallback(
    (offset: number) => {
      const p = new URLSearchParams({ q: query.trim(), limit: String(PAGE), offset: String(offset) });
      if (onlyPriced) p.set("withCogs", "1");
      return p;
    },
    [query, onlyPriced],
  );

  // Results follow the typing; a slower, older answer never replaces a newer one.
  const search = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    api
      .get<Page>(`/catalog?${params(0)}`)
      .then((r) => {
        if (mine !== seq.current) return;
        setItems(r.items);
        setTotal(r.total);
        setStockAsOf(r.stockAsOf);
        setSuggestion(r.suggestion ?? null);
        setPartial(!!r.partial);
        setByMeaning(r.byMeaning ?? 0);
      })
      .finally(() => mine === seq.current && setLoading(false));
  }, [params]);

  useEffect(() => {
    const t = setTimeout(search, 150);
    return () => clearTimeout(t);
  }, [search]);

  // The next page as the list nears its end, so a long result list keeps scrolling.
  const loadMore = () => {
    if (loading || loadingMore || items.length >= total) return;
    const mine = seq.current;
    setLoadingMore(true);
    api
      .get<Page>(`/catalog?${params(items.length)}`)
      .then((r) => {
        if (mine !== seq.current) return;
        setItems((prev) => [...prev, ...r.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      })
      .finally(() => setLoadingMore(false));
  };

  const selected = useMemo(
    () => Object.entries(chosen).filter(([, qty]) => qty > 0),
    [chosen],
  );

  /** The quote line for an item, built in its base unit, then converted to the chosen unit. */
  // A COGS problem doesn't stop the pick: the line goes on the quote held
  // (server/cogsCheck.ts applyHolds), so it isn't forgotten or offered.
  const lineFor = (item: CatalogItem, qty: number): QuoteItem => {
    const line = lineFromCatalog(item, qty, { uom: uomOverride[item.id] });
    return item.cogs_problem ? { ...line, held: true } : line;
  };

  const add = () => {
    const picked = selected
      .map(([id, qty]) => {
        const item = pickedItems[Number(id)];
        return item ? lineFor(item, qty) : null;
      })
      .filter(Boolean) as QuoteItem[];
    const byQuery = new Map<string, string[]>();
    for (const [id] of selected) {
      const q = pickedQuery[Number(id)];
      const item = pickedItems[Number(id)];
      if (q && item) byQuery.set(q, [...(byQuery.get(q) ?? []), item.code]);
    }
    // Learning is best effort: a failure never blocks adding the items.
    for (const [q, codes] of byQuery) void api.post("/catalog/search-picks", { q, codes: codes.slice(0, 50) }).catch(() => undefined);
    onAdd(picked);
  };

  if (creating) {
    return (
      <NewItemForm
        uomOptions={uomOptions}
        initialName={query.trim()}
        onBack={() => setCreating(false)}
        onClose={onClose}
        onCreated={(line) => onAdd([line])}
      />
    );
  }

  return (
    <Modal
      title="Tambah barang dari katalog"
      sub={`${total} barang cocok. ${seeCosts ? "COGS dari inventory, plafon" : "Plafon"} awal dari harga jual master.${stockAsOf ? ` Stok Accurate per ${fmtDateTime(stockAsOf)}.` : ""}`}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <span className="grow muted small">{selected.length} item dipilih</span>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn primary" onClick={add} disabled={!selected.length}>
            Tambahkan {selected.length || ""}
          </button>
        </>
      }
    >
      <div className="search-bar">
        <input
          className="input"
          autoFocus
          placeholder="Cari nama atau kode barang"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Cari katalog"
        />
        <label className="toggle">
          <input type="checkbox" checked={onlyPriced} onChange={(e) => setOnlyPriced(e.target.checked)} />
          <span className="small">Hanya yang punya COGS</span>
        </label>
        <button className="btn small ghost" onClick={() => setCreating(true)}>
          Barang baru
        </button>
      </div>

      {suggestion && (
        <p className="note first">
          Mungkin maksud Anda:{" "}
          <button className="link-btn" onClick={() => setQuery(suggestion)}>
            {suggestion}
          </button>
        </p>
      )}
      {partial && items.length > 0 && (
        <p className="note first">Tidak ada barang yang cocok dengan semua kata. Ini yang paling mendekati.</p>
      )}
      {byMeaning > 0 && items.length > 0 && (
        <p className="note first">{byMeaning} barang ditemukan karena artinya mirip (Pencarian AI), katanya tidak sama persis.</p>
      )}
      {loading && items.length === 0 ? (
        <div className="loading"><span className="dots"><i /><i /><i /></span> Mencari…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <h3>Tidak ada yang cocok</h3>
          <p>
            Barangnya belum ada? Buat sebagai <strong>Barang baru</strong>. Barisnya ditahan sampai barangnya dibuat di Accurate. Baris lain di quotation tetap jalan.
          </p>
          <button className="btn small" onClick={() => setCreating(true)}>
            Barang baru{query.trim() ? `: ${query.trim()}` : ""}
          </button>
        </div>
      ) : (
        <div
          className="table-wrap scroll"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) loadMore();
          }}
        >
          <table className="table">
            <thead>
              <tr>
                <th className="l">Barang</th>
                {seeCosts && <th>COGS</th>}
                <th>Harga jual</th>
                <th>Stok</th>
                <th className="l">Satuan</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const line = lineFor(item, 0);
                const warn = uomWarning(line);
                return (
                <tr key={item.id}>
                  <td className="l">
                    <div className="with-thumb">
                      <Thumb src={item.image} alt={item.name} />
                      <div className="grow">
                        <div className="cell-title">{item.name}</div>
                        <div className="muted small">
                          {item.code}
                          {item.category ? ` · ${item.category}` : ""}
                          {existingCodes.has(normalizeCode(item.code)) && (
                            <span className="badge amber rev-badge">sudah ada</span>
                          )}
                        </div>
                        {item.cogs_problem && (
                          <div className="cell-warn">{item.cogs_problem}. Kalau dipilih, barisnya ditahan sampai dicek manajer.</div>
                        )}
                      </div>
                    </div>
                  </td>
                  {seeCosts && <td className="num">{item.cogs > 0 ? grp(line.cogs) : <span className="muted">—</span>}</td>}
                  <td className="num">{item.list_price > 0 ? grp(line.rrp) : <span className="muted">—</span>}</td>
                  <td className="num muted">{grp(item.stock)}</td>
                  <td className="l">
                    <UomCell
                      value={line.uom}
                      choices={uomOptions.length ? uomChoices(uomOptions, { baseUom: item.uom || "Pcs", units: item.units ?? [] }, line.uom) : []}
                      label={`Satuan ${item.name}`}
                      warning={warn}
                      onChange={(u) => setUomOverride((o) => ({ ...o, [item.id]: u }))}
                    />
                  </td>
                  <td>
                    <input
                      className="cell"
                      type="number"
                      min="0"
                      placeholder="0"
                      value={chosen[item.id] ?? ""}
                      onChange={(e) => {
                        setChosen((c) => ({ ...c, [item.id]: Math.max(0, Number(e.target.value)) }));
                        setPickedItems((p) => ({ ...p, [item.id]: item }));
                        const typed = query.trim();
                        if (typed) setPickedQuery((p) => ({ ...p, [item.id]: typed }));
                      }}
                      aria-label={`Qty untuk ${item.name}`}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {items.length < total && (
            <div className="table-foot">
              <span className="muted small grow">
                {items.length} dari {total} ditampilkan
              </span>
              <button className="btn small ghost" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Memuat…" : "Muat lagi"}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
