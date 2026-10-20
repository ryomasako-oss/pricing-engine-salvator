/* "Latih Pencocokan (Data Feed)": teach the matcher a client's wording without
   making a fake quotation (the CGV case, 2026-10-17). A list is fed, every row
   comes back with what the matcher thinks, and a person settles the rows that
   need one with a click. Each decision is a rule for that wording, so every
   row with the same wording settles with it, and "Dari list klien" uses the
   rule on the client's next list.

   The state is in ./familiarityRows.ts; the server contract in
   ../familiarityApi.ts. */

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { parseRequestList } from "../import/parsers";
import type { RequestLine } from "@shared/match";
import type { CatalogItem, Client } from "@shared/types";
import type { PendingItem } from "@shared/pendingItems";
import type { FamiliarityCandidate, FamiliarityRow } from "@shared/familiarity";
import { ClientQuickAdd } from "./ClientQuickAdd";
import { Icon } from "./Icon";
import { NewItemForm } from "./NewItemForm";
import { STATUS_LABEL } from "./reviewRow";
import { familiarityApi, type NewItemPayload, type ResolveRequest } from "../familiarityApi";
import {
  currentPairing,
  feedLines,
  filterRows,
  linesFromPaste,
  mergeRows,
  pillsFor,
  rowMode,
  workbenchCounts,
  type Filter,
  type RowMode,
} from "./familiarityRows";

const NEW_CLIENT = "__new";

/** The workbench on its own card: for whoever may not see the learning report (sales), or when it failed to load. */
export function FamiliarityCard() {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h3>Latih pencocokan</h3>
        <span className="muted small">Ajari sistem istilah klien tanpa membuat quotation.</span>
      </div>
      <div className="card-body">
        <FamiliarityTraining />
      </div>
    </div>
  );
}

/** The toggle and the workbench behind it. */
export function FamiliarityTraining() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 14 }}>
      <button className={`btn small ${open ? "" : "primary"}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="upload" size={14} /> Latih Pencocokan (Data Feed)
      </button>
      {open && <FamiliarityWorkbench />}
    </div>
  );
}

interface Session {
  id: number;
  clientId: number | null;
  title: string;
}

/** A choice a person can make for a row: an item in the catalog, or a barang baru (requested already or just now). */
type Target = { kind: "catalog"; itemId: string; label: string } | { kind: "pending"; payload: NewItemPayload; label: string };

/**
 * A barang baru as the resolve takes it. The server finds one already requested
 * by its code or its name, but refuses a BARU-… code in the payload (only the
 * counter hands those out), so a numbered request is pointed at by name.
 */
const pendingPayload = (name: string, uom: string, code: string): NewItemPayload => ({
  name,
  uom: uom || "Pcs",
  ...(code && !/^BARU-/i.test(code) ? { code } : {}),
});

const targetOf = (c: FamiliarityCandidate): Target =>
  c.source === "catalog"
    ? { kind: "catalog", itemId: c.item_id!, label: c.name }
    : { kind: "pending", payload: pendingPayload(c.name, c.uom, c.code), label: c.name };

export function FamiliarityWorkbench() {
  const toast = useToast();
  const { can } = useAuth();
  /** Only a manager may store a rule for every client (server: edit_catalog). */
  const mayGoGlobal = can("edit_catalog");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState<number | "">("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [paste, setPaste] = useState("");
  const [file, setFile] = useState<{ name: string; lines: RequestLine[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);

  const [session, setSession] = useState<Session | null>(null);
  const [rows, setRows] = useState<FamiliarityRow[]>([]);
  /** Store each decision for every client, not only this one. */
  const [everyone, setEveryone] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Map<number, string>>(new Map());
  const [searchRow, setSearchRow] = useState<number | null>(null);
  /** Settled rows a person reopened to correct. */
  const [editing, setEditing] = useState<Set<number>>(new Set());
  const [newItemRow, setNewItemRow] = useState<FamiliarityRow | null>(null);
  const [uomOptions, setUomOptions] = useState<string[]>([]);

  useEffect(() => {
    api.get<{ clients: Client[] }>("/clients").then((r) => setClients(r.clients)).catch(() => setClients([]));
    api
      .get<{ options: { name: string }[] }>("/catalog/uom")
      .then((r) => setUomOptions(r.options.map((o) => o.name)))
      .catch(() => setUomOptions([]));
  }, []);

  const lines = file ? file.lines : linesFromPaste(paste);
  const counts = useMemo(() => workbenchCounts(rows), [rows]);
  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    try {
      // The same parser as "Dari list klien": the wording a rule is stored under
      // here is the wording that list will look it up by.
      const { lines } = await parseRequestList(f);
      setFile({ name: f.name, lines });
    } catch (e) {
      setError(e instanceof Error ? e.message : "File tidak terbaca.");
    }
  };

  const feed = async () => {
    setBusy(true);
    setError("");
    try {
      const chosen = clientId === "" ? null : clientId;
      const res = await familiarityApi.feed({ client_id: chosen, title: title.trim(), raw_lines: feedLines(lines) });
      setSession({ id: res.session_id, clientId: chosen, title: title.trim() });
      setRows(res.rows);
      // A rule for every client matches as "Pasti" in every client's Dari list klien, unreviewed:
      // never the default, a manager ticks it.
      setEveryone(false);
      setRowError(new Map());
      setEditing(new Set());
      setFilter("all");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feed gagal.");
    } finally {
      setBusy(false);
    }
  };

  /** Sends one decision; the server answers with every row it settled, twins included. */
  const send = async (row: FamiliarityRow, body: Omit<ResolveRequest, "row_id" | "apply_to_client_only">) => {
    if (!session) return;
    setRowBusy(row.id);
    setRowError((m) => {
      const next = new Map(m);
      next.delete(row.id);
      return next;
    });
    try {
      const res = await familiarityApi.resolve(session.id, { row_id: row.id, apply_to_client_only: !everyone, ...body });
      const settled = new Set(res.rows.map((r) => r.id));
      setRows((rs) => mergeRows(rs, res.rows));
      setEditing((e) => new Set([...e].filter((id) => !settled.has(id))));
      if (searchRow === row.id) setSearchRow(null);
    } catch (e) {
      setRowError((m) => new Map(m).set(row.id, e instanceof Error ? e.message : "Gagal menyimpan."));
    } finally {
      setRowBusy(null);
    }
  };

  const choose = (row: FamiliarityRow, t: Target) =>
    send(row, t.kind === "catalog" ? { action: "verify_item", item_id: t.itemId } : { action: "create_new_item", new_item_payload: t.payload });

  const noClient = session?.clientId == null;
  /** Without a client and without "every client", nothing decided here is remembered after this session. */
  const sessionOnly = noClient && !everyone;

  return (
    <section aria-label="Latih Pencocokan" className="col" style={{ gap: 12, marginTop: 12 }}>
      {!session ? (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Tempel atau unggah daftar barang klien. Setiap baris dicocokkan ke katalog; baris yang Anda bereskan di sini diingat untuk
            daftar klien itu berikutnya, termasuk di <strong>Dari list klien</strong>, tanpa membuat quotation.
          </p>
          {adding ? (
            <ClientQuickAdd
              clients={clients}
              onDone={(c, isNew) => {
                if (isNew) setClients((l) => [...l, c].sort((a, b) => a.name.localeCompare(b.name)));
                setClientId(c.id);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <div className="row-wrap" style={{ gap: 12, alignItems: "end" }}>
              <label className="field" style={{ flex: "1 1 220px" }}>
                <span>Klien</span>
                <select
                  className="select"
                  aria-label="Klien"
                  value={clientId}
                  onChange={(e) => {
                    if (e.target.value === NEW_CLIENT) setAdding(true);
                    else setClientId(e.target.value === "" ? "" : Number(e.target.value));
                  }}
                >
                  <option value="">— tanpa klien —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={NEW_CLIENT}>+ Klien baru…</option>
                </select>
              </label>
              <label className="field" style={{ flex: "2 1 260px" }}>
                <span>Judul feed</span>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="mis. List CGV Oktober" />
              </label>
            </div>
          )}
          {clientId === "" && !adding && (
            // Not .notice.info: that one is 4.4:1 in both themes (styles.css defines it twice).
            <p className="muted small" style={{ margin: 0 }}>
              {mayGoGlobal
                ? "Pilih klien supaya sistem belajar. Tanpa klien, pilihan hanya berlaku di latihan ini, kecuali Anda mencentang \"semua klien\" setelah Cocokkan."
                : "Pilih klien supaya sistem belajar. Tanpa klien, pilihan Anda hanya berlaku di latihan ini dan tidak diingat."}
            </p>
          )}
          <label className="field">
            <span>Tempel daftar barang</span>
            <textarea
              className="textarea input"
              rows={6}
              value={paste}
              disabled={!!file}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={"Satu barang per baris, mis.\nKertas HVS A4 70gr\nLakban bening 2 inch"}
            />
          </label>
          <div
            className={`drop ${drag ? "drag" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              // Without this the browser opens the dropped file and everything typed here is gone.
              e.preventDefault();
              setDrag(false);
              void readFile(e.dataTransfer.files?.[0]);
            }}
          >
            <Icon name="upload" size={20} />
            <div className="row-wrap" style={{ gap: 8, alignItems: "center" }}>
              {file ? (
                <>
                  <span className="badge grey">{file.name}</span>
                  <span className="muted small">{file.lines.length} baris</span>
                  <button className="btn small ghost" onClick={() => setFile(null)}>Pakai teks tempelan</button>
                </>
              ) : (
                <>
                  <span className="muted small">Atau tarik file Excel/CSV daftar klien ke sini</span>
                  <label className="btn small">
                    Pilih file
                    <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => void readFile(e.target.files?.[0])} />
                  </label>
                </>
              )}
            </div>
          </div>
          {error && <p className="notice error">{error}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" onClick={feed} disabled={busy || !lines.length}>
              {busy ? "Mencocokkan…" : "Cocokkan"}
            </button>
            {lines.length > 0 && <span className="muted small">{lines.length} baris</span>}
          </div>
        </>
      ) : (
        <>
          <div className="row-wrap" style={{ gap: 6, alignItems: "center" }}>
            <span className="badge grey">{session.title || "Feed tanpa judul"}</span>
            {counts.adjustment > 0 && <span className="badge blue">{counts.adjustment} adjustment</span>}
            {counts.review > 0 && <span className="badge amber">{counts.review} perlu dicek</span>}
            <span className="grow" />
            <button className="btn small ghost" onClick={() => setSession(null)}>Feed baru</button>
          </div>
          {mayGoGlobal && (
            <label className="row" style={{ gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
              <span className="small">
                Simpan pilihan untuk semua klien{noClient ? "" : ", bukan hanya klien ini"} (langsung Pasti di list semua klien)
              </span>
            </label>
          )}
          {sessionOnly && (
            <p className="notice warn small" style={{ margin: 0 }}>
              Latihan tanpa klien: pilihan di sini hanya berlaku di sesi ini dan tidak diingat untuk daftar berikutnya. Mulai feed baru
              dengan klien supaya sistem belajar.
            </p>
          )}
          <div className="row-wrap" style={{ gap: 6 }} role="group" aria-label="Saring baris">
            {(
              [
                ["all", `Semua (${counts.all})`],
                ["todo", `Perlu Dibereskan (${counts.todo})`],
                ["familiar", `Sudah Familiar (${counts.familiar})`],
              ] as const
            ).map(([f, label]) => (
              <button key={f} className={`btn small ${filter === f ? "primary" : "ghost"}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>

          <div className="table-wrap" style={{ maxHeight: "60vh" }}>
            <table className="table">
              <thead>
                <tr>
                  <th className="l">Teks klien</th>
                  <th className="l">Status</th>
                  <th className="l">Pasangan</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <WorkbenchRow
                    key={row.id}
                    row={row}
                    busy={rowBusy === row.id}
                    error={rowError.get(row.id)}
                    mode={rowMode(row)}
                    editing={editing.has(row.id)}
                    onEdit={() => setEditing((e) => new Set(e).add(row.id))}
                    onCancel={() => {
                      setEditing((e) => new Set([...e].filter((id) => id !== row.id)));
                      if (searchRow === row.id) setSearchRow(null);
                    }}
                    searching={searchRow === row.id}
                    onSearch={() => setSearchRow(searchRow === row.id ? null : row.id)}
                    onChoose={(t) => void choose(row, t)}
                    onNewItem={() => setNewItemRow(row)}
                    onHeader={() => void send(row, { action: "ignore_row" })}
                  />
                ))}
                {!shown.length && (
                  <tr>
                    <td className="l muted" colSpan={3}>Tidak ada baris di saringan ini.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {newItemRow && (
        <NewItemForm
          uomOptions={uomOptions}
          initialName={newItemRow.raw_text}
          fixedQty={newItemRow.qty || 1}
          onBack={() => setNewItemRow(null)}
          onClose={() => setNewItemRow(null)}
          onCreated={(_line, item) => {
            const row = newItemRow;
            setNewItemRow(null);
            toast(`"${item.name}" diminta ke Accurate.`);
            // The request exists now; the server finds it by its code instead of making a second one.
            void choose(row, { kind: "pending", payload: pendingPayload(item.name, item.uom, item.code), label: item.name });
          }}
        />
      )}
    </section>
  );
}

function WorkbenchRow({
  row,
  busy,
  error,
  mode,
  editing,
  onEdit,
  onCancel,
  searching,
  onSearch,
  onChoose,
  onNewItem,
  onHeader,
}: {
  row: FamiliarityRow;
  busy: boolean;
  error?: string;
  mode: RowMode;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  searching: boolean;
  onSearch: () => void;
  onChoose: (t: Target) => void;
  onNewItem: () => void;
  onHeader: () => void;
}) {
  const acting = mode === "todo" || editing;
  const r = row.resolved;
  const badge = r
    ? r.action === "ignore_row"
      ? { text: "Header", cls: "grey" }
      : { text: "Sudah dibereskan", cls: "green" }
    : STATUS_LABEL[row.match.status];
  const now = currentPairing(row);
  // Correcting: the pairing in place now is not an answer to offer.
  const offered = pillsFor(row, editing);

  return (
    <tr>
      <td className="l" style={{ minWidth: 200 }}>
        <div style={{ fontWeight: 550 }}>{row.raw_text}</div>
        {/* The server reads a missing quantity as 1: only a stated one is worth showing. */}
        {(row.qty !== 1 || row.unit) && <div className="muted small">{[row.qty, row.unit].filter(Boolean).join(" ")}</div>}
      </td>
      <td className="l">
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </td>
      <td className="l" style={{ minWidth: 360 }}>
        {!acting ? (
          <div className="col" style={{ gap: 6 }}>
            <div className="row-wrap" style={{ gap: 8, alignItems: "center" }}>
              <span>{now.label}</span>
              {/* The matcher was sure on its own: a person can make it a rule, or say it is wrong. */}
              {mode === "auto" && now.candidate && (
                <button className="btn small" onClick={() => onChoose(targetOf(now.candidate!))} disabled={busy}>
                  Benar
                </button>
              )}
              <button className="btn small ghost" onClick={onEdit} disabled={busy}>
                Koreksi
              </button>
            </div>
            {error && <span className="notice error small">{error}</span>}
          </div>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {editing && <span className="muted small">Sekarang: {now.label}</span>}
            <div className="row-wrap" style={{ gap: 6, alignItems: "center" }}>
              {offered.map((c) => (
                <button key={`${c.source}-${c.item_id ?? c.pending_item_id}`} className="chip" type="button" disabled={busy} onClick={() => onChoose(targetOf(c))}>
                  {c.source === "pending" && <span className="badge blue">Sudah diajukan</span>} {c.name}{" "}
                  <span className="muted">
                    · {c.code}
                    {c.score < 1 ? ` · ${Math.round(c.score * 100)}%` : ""}
                  </span>
                </button>
              ))}
              <button className="icon-btn" title="Cari di katalog" aria-label={`Cari di katalog untuk ${row.raw_text}`} onClick={onSearch} disabled={busy}>
                <Icon name="search" size={15} />
              </button>
            </div>
            <div className="row-wrap" style={{ gap: 6 }}>
              <button className="btn small" onClick={onNewItem} disabled={busy}>
                Barang Baru
              </button>
              <button className="btn small ghost" onClick={onHeader} disabled={busy} title="Baris ini judul kolom atau keterangan, bukan barang.">
                Bukan Barang / Header
              </button>
              {editing && (
                <button className="btn small ghost" onClick={onCancel} disabled={busy}>
                  Batal
                </button>
              )}
            </div>
            {searching && <InlineSearch initial={row.raw_text} onPick={onChoose} />}
            {error && <span className="notice error small">{error}</span>}
          </div>
        )}
      </td>
    </tr>
  );
}

/** The main catalog and barang baru already requested, so a request is never made twice. */
function InlineSearch({ initial, onPick }: { initial: string; onPick: (t: Target) => void }) {
  const [q, setQ] = useState(initial);
  const [found, setFound] = useState<(Target & { key: string; code: string })[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true);
    try {
      const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const [catalog, requested] = await Promise.all([
        api.get<{ items: CatalogItem[] }>(`/catalog?${new URLSearchParams({ q: q.trim(), limit: "8" })}`),
        api.get<{ items: PendingItem[] }>("/pending-items").catch(() => ({ items: [] as PendingItem[] })),
      ]);
      const live = requested.items.filter(
        (p) => (p.status === "draft" || p.status === "submitted") && words.every((w) => p.name.toLowerCase().includes(w)),
      );
      setFound([
        ...live.map((p) => ({
          key: `pending-${p.id}`,
          kind: "pending" as const,
          code: p.code,
          label: p.name,
          payload: pendingPayload(p.name, p.uom, p.code),
        })),
        ...catalog.items.map((it) => ({ key: `item-${it.id}`, kind: "catalog" as const, code: it.code, label: it.name, itemId: String(it.id) })),
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 6 }}>
      <form
        className="row"
        style={{ gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Kata kunci katalog" />
        <button className="btn small" type="submit" disabled={busy || !q.trim()}>
          Cari
        </button>
      </form>
      {found && found.length === 0 && <span className="muted small">Tidak ada. Coba kata kunci lebih pendek, misal merek saja.</span>}
      <div className="row-wrap" style={{ gap: 6 }}>
        {found?.map((t) => (
          <button key={t.key} className="chip" type="button" onClick={() => onPick(t)}>
            {t.kind === "pending" && <span className="badge blue">Sudah diajukan</span>} {t.label} <span className="muted">· {t.code}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
