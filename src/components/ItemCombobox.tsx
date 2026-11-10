/* One place to pick a row's catalog item in Dari list klien (Ryoma, 9 Nov: the dropdown plus the
   search looked like "two versions"). Closed, it shows the row's pick. Open with nothing typed, it lists
   the match's suggestions; typing searches the whole catalog (useCatalogSearch). A name picks it for
   the row; [+] adds it as one more item for the request (its own quote line). It closes after a pick,
   on Escape, on a click outside, or when another row is touched (ListToQuote). */

import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { grp } from "@shared/format";
import type { CatalogItem } from "@shared/types";
import { useCatalogSearch } from "./useCatalogSearch";
import { Icon } from "./Icon";

export interface Suggestion {
  item: CatalogItem;
  /** Match score 0-1, shown as % when below 1. */
  score?: number;
}

export function ItemCombobox({
  label,
  value,
  suggestions,
  seeCosts,
  added,
  open,
  onOpen,
  onClose,
  onChoose,
  onAdd,
}: {
  /** Accessible name, e.g. "Item katalog untuk Pulpen Gel Artline". */
  label: string;
  value: CatalogItem | undefined;
  suggestions: Suggestion[];
  /** PE-1: a rep gets no COGS from the server, so none is printed. */
  seeCosts: boolean;
  /** Ids already added as extra items, marked as such. */
  added: number[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** null = the row is left out ("tidak dipakai"). */
  onChoose: (item: CatalogItem | null) => void;
  onAdd: (item: CatalogItem) => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { items: found, total, suggestion, partial, busy, loadMore, fresh } = useCatalogSearch(open ? q : "");

  // Each opening starts from the suggestions.
  useEffect(() => {
    if (!open) return setQ("");
    setActive(0);
    const outside = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, onClose]);

  const typing = q.trim().length > 0;
  // While typing, only results for what is typed now: an older search's list must not be picked by Enter.
  const options: Suggestion[] = typing ? (fresh ? (found ?? []) : []).map((item) => ({ item })) : suggestions;
  useEffect(() => setActive(0), [q]);

  const choose = (item: CatalogItem | null) => {
    // A pick after typing teaches the search (shared/catalogSearch.ts "picked"); best effort.
    if (item && typing && item.source !== "pending") void api.post("/catalog/search-picks", { q: q.trim(), codes: [item.code] }).catch(() => undefined);
    onChoose(item);
    onClose();
    input.current?.blur();
  };

  const describe = (s: Suggestion) =>
    [
      s.item.code,
      seeCosts ? `COGS ${grp(s.item.cogs)}` : s.item.uom || "Pcs",
      s.score != null && s.score < 1 ? `${Math.round(s.score * 100)}%` : "",
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="combo" ref={root}>
      <div className="combo-field">
        <input
          ref={input}
          className="input"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          value={open ? q : value ? value.name : ""}
          placeholder={open ? value?.name || "Ketik untuk mencari di katalog" : "— tidak dipakai —"}
          onFocus={onOpen}
          // Tab out of the box (not into its own list) puts it away.
          onBlur={(e) => {
            if (open && !root.current?.contains(e.relatedTarget as Node | null)) onClose();
          }}
          onClick={onOpen}
          onChange={(e) => {
            if (!open) onOpen();
            setQ(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.stopPropagation();
              onClose();
              input.current?.blur();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) onOpen();
              setActive((a) => Math.min(a + 1, Math.max(0, options.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && open && options[active] && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(options[active].item);
            }
          }}
        />
        {value?.cogs_problem && !open && <span className="badge amber combo-flag">COGS bermasalah</span>}
        {value && (
          <button type="button" className="icon-btn" aria-label={`Kosongkan pilihan untuk ${label.replace(/^Item katalog untuk /, "")}`} title="Tidak dipakai" onClick={() => choose(null)}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      {open && (
        <div className="combo-pop">
          <div className="combo-group muted small">
            {typing
              ? !fresh
                ? "Mencari…"
                : partial
                  ? "Tidak ada yang cocok dengan semua kata · ini yang paling mendekati"
                  : `Hasil cari katalog${total ? ` · ${grp(total)} barang` : ""}`
              : "Saran pencocokan · ketik untuk mencari di seluruh katalog"}
          </div>
          {typing && suggestion && (
            <div className="combo-group small">
              Mungkin maksud Anda:{" "}
              <button type="button" className="link-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setQ(suggestion)}>
                {suggestion}
              </button>
            </div>
          )}
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="combo-list"
            onScroll={(e) => {
              const el = e.currentTarget;
              if (typing && el.scrollTop + el.clientHeight > el.scrollHeight - 80) loadMore();
            }}
          >
            {options.length === 0 && (
              <li className="combo-empty muted small">{typing ? (!fresh || busy ? "Mencari…" : "Tidak ada. Coba kata yang lebih pendek, misal merek saja.") : "Belum ada saran. Ketik untuk mencari."}</li>
            )}
            {options.map((s, k) => {
              const isAdded = added.includes(s.item.id);
              const isValue = value?.id === s.item.id;
              return (
                <li
                  key={s.item.id}
                  id={`${listId}-${k}`}
                  role="option"
                  aria-selected={k === active}
                  className={`combo-option${k === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(k)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(s.item)}
                >
                  <span className="grow">
                    <span className="combo-name">{s.item.name}</span>
                    {isValue && <span className="badge green">dipilih</span>}
                    <span className="muted small"> · {describe(s)}</span>
                    {s.item.cogs_problem && <span className="cell-warn small"> · COGS bermasalah</span>}
                  </span>
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={isAdded || isValue || s.item.source === "pending"}
                    aria-label={`Tambah ${s.item.name} sebagai barang lain`}
                    title={
                      s.item.source === "pending"
                        ? "Barang baru belum ada di katalog: pilih sebagai barang baris ini"
                        : isAdded
                          ? "Sudah ditambahkan"
                          : "Tambah sebagai barang lain (baris sendiri)"
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAdd(s.item);
                    }}
                  >
                    {isAdded ? "Ditambah" : "+ Tambah"}
                  </button>
                </li>
              );
            })}
            {typing && fresh && found && found.length < total && (
              <li className="combo-empty">
                <button type="button" className="btn small ghost" onMouseDown={(e) => e.preventDefault()} onClick={loadMore} disabled={busy}>
                  Muat lagi ({found.length} dari {total})
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
