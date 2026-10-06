/* Builds a quotation straight from a client's request list.

   The file is parsed in the browser into plain requests (name, qty, unit),
   the server matches each against the catalog (code, learned alias, then
   name similarity), and the rep reviews the pairing before anything is
   created. Prices are never typed or guessed here: COGS and the default
   ceiling come from the matched catalog row, converted to the requested unit.

   Pairings the rep confirmed or corrected are saved as aliases for the
   chosen client, so that client's next list matches by itself. With no
   client chosen nothing is saved (see create()). */

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { grp } from "@shared/format";
import { lineFromCatalog, type MatchResult, type RequestLine } from "@shared/match";
import type { CatalogItem, Client, QuoteItem } from "@shared/types";
import { uomWarning } from "@shared/uom";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

const MAX_LINES = 500;

interface MatchResponse {
  results: MatchResult[];
  items: CatalogItem[];
  summary: Record<MatchResult["status"], number>;
}

interface Row {
  request: RequestLine;
  result: MatchResult;
  /** Catalog item id the line will use, or null to leave the line out. */
  chosen: number | null;
  /** The rep accepted or changed the pairing (required for "review" rows). */
  confirmed: boolean;
  /** Extra items found by a manual search for this row. */
  extra: number[];
}

const STATUS_LABEL: Record<MatchResult["status"], { text: string; cls: string }> = {
  exact: { text: "Pasti", cls: "green" },
  match: { text: "Cocok", cls: "green" },
  review: { text: "Perlu dicek", cls: "amber" },
  none: { text: "Tidak ketemu", cls: "red" },
};

export function ListToQuote({
  clients,
  onClose,
  onCreated,
}: {
  clients: Client[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const toast = useToast();
  // Staff see the price the server will charge instead of COGS (PE-1).
  const seeCosts = useAuth().can("view_costs");
  const [clientId, setClientId] = useState<number | "">("");
  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [items, setItems] = useState<Map<number, CatalogItem>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const [searchRow, setSearchRow] = useState<number | null>(null);

  const read = async (file?: File | null) => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const { parseRequestList } = await import("../import/parsers");
      const { lines, report } = await parseRequestList(file);
      if (lines.length > MAX_LINES) {
        throw new Error(`File berisi ${lines.length} baris; maksimal ${MAX_LINES} per quotation. Pecah filenya dulu.`);
      }
      const res = await api.post<MatchResponse>("/catalog/match", {
        client_id: clientId === "" ? null : clientId,
        lines,
      });
      setItems(new Map(res.items.map((i) => [i.id, i])));
      setRows(
        res.results.map((result) => ({
          request: lines[result.index],
          result,
          chosen: result.status === "none" ? null : result.candidates[0]?.id ?? null,
          confirmed: result.status === "exact" || result.status === "match",
          extra: [],
        })),
      );
      setNotes(report.notes);
      setFileName(file.name);
      if (!title) {
        const client = clients.find((c) => c.id === clientId);
        setTitle(client ? `Penawaran ${client.name}` : file.name.replace(/\.[^.]+$/, ""));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "File tidak bisa dibaca.");
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const lines = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => {
      const item = r.chosen != null ? items.get(r.chosen) : undefined;
      // A catalog item with a bad COGS must not be sold (shared/cogsCheck.ts).
      return item && !item.cogs_problem
        ? lineFromCatalog(item, r.request.qty ?? 1, { uom: r.request.uom, rrp: r.request.rrp })
        : null;
    });
  }, [rows, items]);

  // Prices for staff: the same lines the quote will be built from, priced by
  // the server without saving anything. Index i -> unit price.
  const [prices, setPrices] = useState<Record<number, number>>({});
  const previewKey = JSON.stringify(lines.map((l) => l && [l.code, l.qty, l.uom, l.rrp]));
  useEffect(() => {
    if (seeCosts || !rows) return;
    const send = lines
      .map((l, i) => l && { id: `r${i}`, code: l.code, name: l.name, qty: l.qty, uom: l.uom, rrp: l.rrp })
      .filter(Boolean);
    if (!send.length) return setPrices({});
    let live = true;
    const t = setTimeout(() => {
      api
        .post<{ quote: { items: { id: string; price: number }[] } }>("/quotes/preview", { snapshot: { items: send } })
        .then((r) => live && setPrices(Object.fromEntries(r.quote.items.map((it) => [Number(it.id.slice(1)), it.price]))))
        .catch(() => live && setPrices({}));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // previewKey stands for `lines`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, seeCosts]);

  const blockedOf = (r: Row) => (r.chosen != null ? items.get(r.chosen)?.cogs_problem ?? null : null);
  const pending = rows?.filter((r) => r.chosen != null && !r.confirmed && !blockedOf(r)).length ?? 0;
  const blockedCount = rows?.filter((r) => blockedOf(r)).length ?? 0;
  const used = lines.filter(Boolean).length;
  // Rows left out by choice (or with nothing found), not counting blocked ones.
  const skipped = (rows?.length ?? 0) - used - blockedCount;


  const create = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const quoteItems = (lines.filter(Boolean) as QuoteItem[]).map((l, i) => ({ ...l, lineNo: i + 1 }));
      const r = await api.post<{ quote: { id: number } }>("/quotes", {
        title: title.trim(),
        client_id: clientId === "" ? null : clientId,
        snapshot: { items: quoteItems },
      });
      // Learn the pairings a person actually looked at: the ones that needed a
      // check or were changed. Code matches need no alias; untouched automatic
      // matches are left alone so a wrong guess never hardens into a rule.
      // Only for a chosen client: an alias without one would skip review for
      // every rep and every client, so one hurried "Benar" would become a
      // company-wide rule.
      const pairs = clientId === "" ? [] : rows
        .filter((row) => row.chosen != null && !blockedOf(row) && row.result.via !== "code")
        .filter((row) => row.result.status === "review" || row.result.status === "none" || row.chosen !== row.result.candidates[0]?.id)
        .map((row) => ({ text: row.request.name, code: items.get(row.chosen!)!.code }));
      if (pairs.length) {
        await api
          .post("/catalog/aliases", { client_id: clientId, pairs })
          .catch(() => toast("Quotation dibuat, tetapi pasangan nama-katalog gagal disimpan untuk lain kali.", "error"));
      }
      onCreated(r.quote.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal membuat quotation.", "error");
      setBusy(false);
    }
  };

  const summary = rows && {
    sure: rows.filter((r) => r.result.status === "exact" || r.result.status === "match").length,
    review: rows.filter((r) => r.result.status === "review").length,
    none: rows.filter((r) => r.result.status === "none").length,
  };

  return (
    <Modal
      title="Quotation dari list klien"
      sub="Upload daftar kebutuhan klien. Setiap baris dicocokkan ke katalog; harga dan COGS diambil dari database."
      size={rows ? "full" : "normal"}
      onClose={onClose}
      footer={
        rows ? (
          <>
            <span className="grow muted small">
              {used} item masuk{skipped ? ` · ${skipped} tidak dipakai` : ""}
              {pending ? ` · ${pending} perlu dicek dulu` : ""}
              {blockedCount ? ` · ${blockedCount} diblokir (COGS tidak wajar)` : ""}
            </span>
            <button className="btn ghost" onClick={() => setRows(null)} disabled={busy}>Ganti file</button>
            <button className="btn primary" onClick={create} disabled={busy || !used || pending > 0 || !title.trim()}>
              {busy ? "Membuat…" : `Buat quotation (${used} item)`}
            </button>
          </>
        ) : (
          <button className="btn ghost" onClick={onClose}>Batal</button>
        )
      }
    >
      {!rows ? (
        <div className="col" style={{ gap: 12 }}>
          <label className="field">
            <span>Klien</span>
            <select
              className="select"
              value={clientId}
              onChange={(e) => setClientId(e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">Tanpa klien</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <p className="muted small" style={{ margin: "-6px 0 0" }}>
            {clientId === ""
              ? "Tanpa klien, pilihan Anda tidak diingat. Pilih klien supaya istilah yang Anda cek otomatis cocok di list berikutnya."
              : "Istilah yang Anda cek atau ganti akan diingat untuk klien ini, jadi list berikutnya lebih cepat."}
          </p>
          <div
            className={`drop ${drag ? "drag" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void read(e.dataTransfer.files?.[0]);
            }}
          >
            <Icon name="upload" size={24} />
            <div>
              <strong>Tarik file Excel klien ke sini</strong>
              <div className="muted small">
                Cukup kolom nama barang dan qty. Kolom kode, satuan, dan harga maksimal dipakai kalau ada.
              </div>
            </div>
            <label className="btn" aria-disabled={busy}>
              {busy ? "Mencocokkan…" : "Pilih file"}
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                hidden
                disabled={busy}
                onChange={(e) => void read(e.target.files?.[0])}
              />
            </label>
          </div>
          {error && <p className="notice error">{error}</p>}
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <div className="row-wrap" style={{ gap: 12, alignItems: "end" }}>
            <label className="field" style={{ flex: "1 1 260px" }}>
              <span>Judul quotation</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="row-wrap" style={{ gap: 6 }}>
              <span className="badge grey">{fileName}</span>
              <span className="badge green">{summary!.sure} cocok</span>
              {summary!.review > 0 && <span className="badge amber">{summary!.review} perlu dicek</span>}
              {summary!.none > 0 && <span className="badge red">{summary!.none} tidak ketemu</span>}
              {blockedCount > 0 && <span className="badge red">{blockedCount} diblokir</span>}
            </div>
          </div>
          {notes.map((n) => (
            <p key={n} className="notice info">{n}</p>
          ))}

          <div className="table-wrap" style={{ maxHeight: "58vh" }}>
            <table className="table">
              <thead>
                <tr>
                  <th className="l">#</th>
                  <th className="l">Permintaan klien</th>
                  <th>Qty</th>
                  <th className="l">Item katalog</th>
                  <th className="l">Status</th>
                  <th>{seeCosts ? "COGS" : "Harga satuan"}</th>
                  <th>Plafon (RRP)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const line = lines[i];
                  const label = STATUS_LABEL[row.result.status];
                  const options = [...row.result.candidates.map((c) => c.id), ...row.extra.filter((id) => !row.result.candidates.some((c) => c.id === id))];
                  const scoreOf = new Map(row.result.candidates.map((c) => [c.id, c.score]));
                  const warn = line ? uomWarning(line) : null;
                  return (
                    <tr key={i} style={row.chosen == null ? { opacity: 0.6 } : undefined}>
                      <td className="l muted">{i + 1}</td>
                      <td className="l">
                        <div style={{ fontWeight: 550 }}>{row.request.name}</div>
                        <div className="muted small">
                          {[row.request.code, row.request.noQty ? "Tanpa qty: 1 per satuan terkecil" : row.request.uom]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </div>
                      </td>
                      <td className="num">{grp(row.request.qty ?? 1)}</td>
                      <td className="l" style={{ minWidth: 320 }}>
                        <div className="row" style={{ gap: 6 }}>
                          <select
                            className="select"
                            aria-label={`Item katalog untuk ${row.request.name}`}
                            value={row.chosen ?? ""}
                            onChange={(e) =>
                              update(i, { chosen: e.target.value === "" ? null : Number(e.target.value), confirmed: true })
                            }
                          >
                            <option value="">— tidak dipakai —</option>
                            {options.map((id) => {
                              const it = items.get(id);
                              if (!it) return null;
                              const score = scoreOf.get(id);
                              return (
                                <option key={id} value={id}>
                                  {it.name} ({it.code}){score != null && score < 1 ? ` · ${Math.round(score * 100)}%` : ""}
                                  {it.cogs_problem ? " · COGS bermasalah" : ""}
                                </option>
                              );
                            })}
                          </select>
                          <button
                            className="icon-btn"
                            title="Cari di katalog"
                            aria-label={`Cari di katalog untuk ${row.request.name}`}
                            onClick={() => setSearchRow(searchRow === i ? null : i)}
                          >
                            <Icon name="search" size={15} />
                          </button>
                        </div>
                        {searchRow === i && (
                          <CatalogSearch
                            initial={row.request.name}
                            onPick={(it) => {
                              setItems((m) => new Map(m).set(it.id, it));
                              update(i, { chosen: it.id, confirmed: true, extra: [...row.extra, it.id] });
                              setSearchRow(null);
                            }}
                          />
                        )}
                        {row.result.via === "alias" && (
                          <div className="muted small">Dari pilihan sebelumnya untuk istilah ini</div>
                        )}
                        {warn && <div className="small" style={{ color: "var(--warn)" }}>⚠ {warn}</div>}
                        {blockedOf(row) && (
                          <div className="small" style={{ color: "var(--danger)" }}>
                            ⛔ {blockedOf(row)}. Item ini tidak boleh dijual; pilih item lain atau perbaiki COGS di katalog.
                          </div>
                        )}
                      </td>
                      <td className="l">
                        {blockedOf(row) ? (
                          <span className="badge red">Diblokir</span>
                        ) : row.chosen != null && !row.confirmed ? (
                          <button
                            className="btn small"
                            onClick={() => update(i, { confirmed: true })}
                            aria-label={`Benar, pakai saran untuk ${row.request.name}`}
                          >
                            <Icon name="check" size={13} /> Benar
                          </button>
                        ) : (
                          <span className={`badge ${row.chosen == null ? "grey" : row.result.status === "review" ? "green" : label.cls}`}>
                            {row.chosen == null ? "Tidak dipakai" : row.result.status === "review" ? "Sudah dicek" : label.text}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {!line ? (
                          <span className="muted">—</span>
                        ) : seeCosts ? (
                          grp(line.cogs)
                        ) : prices[i] != null ? (
                          <strong>{grp(prices[i])}</strong>
                        ) : (
                          <span className="muted">…</span>
                        )}
                      </td>
                      <td className="num">{line ? grp(line.rrp) : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Small inline catalog search for a row the matcher could not resolve. */
function CatalogSearch({ initial, onPick }: { initial: string; onPick: (item: CatalogItem) => void }) {
  const [q, setQ] = useState(initial);
  const [found, setFound] = useState<CatalogItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true);
    try {
      const r = await api.get<{ items: CatalogItem[] }>(`/catalog?${new URLSearchParams({ q: q.trim(), limit: "8" })}`);
      setFound(r.items);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 6, marginTop: 6 }}>
      <form
        className="row"
        style={{ gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Kata kunci katalog" />
        <button className="btn small" type="submit" disabled={busy || !q.trim()}>Cari</button>
      </form>
      {found && found.length === 0 && <span className="muted small">Tidak ada. Coba kata kunci lebih pendek, misal merek saja.</span>}
      {found?.map((it) => (
        <button key={it.id} className="chip" type="button" onClick={() => onPick(it)}>
          {it.name} <span className="muted">· {it.code} · COGS {grp(it.cogs)}</span>
        </button>
      ))}
    </div>
  );
}
