/* Builds a quotation straight from a client's request list.

   The file is parsed in the browser into plain requests (name, qty, unit),
   the server matches each against the catalog (code, learned alias, then
   name similarity), and the rep reviews the pairing before anything is
   created. Prices are never typed or guessed here: COGS and the default
   ceiling come from the matched catalog row. A line goes on the quote in
   Accurate's smallest unit: 2 Box of 12 becomes 24 Pcs (shared/match.ts toBase).

   Pairings the rep confirmed or corrected are saved as aliases for the
   chosen client, so that client's next list matches by itself. With no
   client chosen nothing is saved (see create()).

   The review can be saved as a draft and sent to a PIC who finishes it
   (shared/listDrafts.ts): a draft keeps the read lines and the picks by
   code, and opening it matches the lines again so prices are today's. */

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { grp } from "@shared/format";
import { shownCode } from "@shared/pendingItems";
import { lineFromCatalog, type MatchResult, type RequestLine } from "@shared/match";
import { choicesFromRows, codesToFetch, restoreRows, type Draft } from "@shared/listDrafts";
import type { CatalogItem, Client, QuoteItem } from "@shared/types";
import { packUnitNeedsCheck, readPackUnit, sameUom, unitAssumed, uomWarning } from "@shared/uom";
import { Icon } from "./Icon";
import { ClientQuickAdd } from "./ClientQuickAdd";
import { Modal } from "./Modal";
import { NewItemForm } from "./NewItemForm";
import { reviewRowBadge, reviewSummary, type RowState } from "./reviewRow";
import { WaitingLine } from "./WaitingLine";

const MAX_LINES = 500;

// What is really happening in each step. The AI step is the slow one (a scan can take a minute).
const WAITING: Record<"file" | "ai" | "match", string[]> = {
  file: ["Membaca file Excel…", "Mencari kolom nama barang dan qty…"],
  ai: [
    "Mengirim dokumen ke AI pembaca…",
    "AI membaca tabel baris demi baris…",
    "Menyalin nama barang, qty, dan satuan…",
    "AI hanya membaca isi dokumen. Harga tidak dikarang, hanya plafon yang tertulis di dokumen.",
    "File scan atau besar bisa sampai 1 menit. Mohon tunggu…",
  ],
  match: [
    "Mencocokkan tiap baris ke katalog…",
    "Harga dan COGS diambil dari database, bukan dari AI.",
    "Menyiapkan tampilan tinjau…",
  ],
};

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
  /** Accepted with "Terima semua saran": never saved as an alias or as learning feedback. */
  bulk?: boolean;
  /** The rep looked at a unit read from the wording (see packUnitNeedsCheck). Reset when the item changes. */
  unitOk: boolean;
  /** Extra items found by a manual search for this row. */
  extra: number[];
}

export function ListToQuote({
  clients,
  onClose,
  onCreated,
  onClientAdded,
  initial,
  draftId,
  onDraftChanged,
}: {
  clients: Client[];
  onClose: () => void;
  onCreated: (id: number) => void;
  onClientAdded?: (client: Client) => void;
  /** A list that is already read (from chat): skips the file step and goes straight to review. */
  initial?: { lines: RequestLine[]; clientId: number | ""; title: string };
  /** A saved draft to reopen where it was left: skips the file step. */
  draftId?: number;
  /** A draft was saved or sent, so a list showing drafts can refresh. */
  onDraftChanged?: () => void;
}) {
  const toast = useToast();
  // Staff see the price the server will charge instead of COGS (PE-1).
  const seeCosts = useAuth().can("view_costs");
  const skipReview = useAuth().can("skip_match_review");
  const [clientId, setClientId] = useState<number | "">(initial?.clientId ?? "");
  const [list, setList] = useState(clients);
  const [adding, setAdding] = useState(false);
  const chooseClient = (client: Client, isNew: boolean) => {
    if (isNew) {
      setList((l) => [...l, client].sort((a, b) => a.name.localeCompare(b.name)));
      onClientAdded?.(client);
    }
    setClientId(client.id);
    setAdding(false);
  };
  const [title, setTitle] = useState(initial?.title ?? "");
  const [fileName, setFileName] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [items, setItems] = useState<Map<number, CatalogItem>>(new Map());
  const [busy, setBusy] = useState(false);
  /** What the wait is for, so the waiting line only says things that are true right now. */
  const [stage, setStage] = useState<"file" | "ai" | "match">("match");
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const [searchRow, setSearchRow] = useState<number | null>(null);
  /** Row whose "Barang baru" form is open (catatan 24/25: a row with no match can still become an item). */
  const [newItemRow, setNewItemRow] = useState<number | null>(null);
  const [uomOptions, setUomOptions] = useState<string[]>([]);
  /** The saved draft this review is (null until the first save). */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  /** The "Kirim ke PIC" form is open. */
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api
      .get<{ options: { name: string }[] }>("/catalog/uom")
      .then((r) => setUomOptions(r.options.map((o) => o.name)))
      .catch(() => setUomOptions([]));
  }, []);

  /** Match request rows against the catalog and open the review. */
  const match = async (lines: RequestLine[], extraNotes: string[], label: string) => {
    if (lines.length > MAX_LINES) {
      throw new Error(`Daftar berisi ${lines.length} baris; maksimal ${MAX_LINES} per quotation. Pecah dulu.`);
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
        unitOk: false,
        extra: [],
      })),
    );
    setNotes(extraNotes);
    setFileName(label);
  };

  // A list handed over from chat is matched as soon as the dialog opens.
  useEffect(() => {
    if (!initial) return;
    setBusy(true);
    match(initial.lines, [], "Chat")
      .catch((e) => setError(e instanceof Error ? e.message : "Daftar tidak bisa dicocokkan."))
      .finally(() => setBusy(false));
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A saved draft: match its lines again as whoever opens it, then lay the saved picks over the result.
  useEffect(() => {
    if (!draftId) return;
    setBusy(true);
    (async () => {
      const { draft: d } = await api.get<{ draft: Draft }>(`/list-drafts/${draftId}`);
      if (d.status === "done") throw new Error("Draft ini sudah dijadikan quotation.");
      if (d.status !== "open") throw new Error("Draft ini sudah dibatalkan.");
      const res = await api.post<MatchResponse>("/catalog/match", { client_id: d.client_id, lines: d.lines });
      // Items picked by hand aren't in the match: fetch them by code, through the same viewer filter.
      const found = await Promise.all(
        codesToFetch(d.choices, res.items).map((code) =>
          api
            .get<{ items: CatalogItem[] }>(`/catalog?${new URLSearchParams({ q: code, limit: "5" })}`)
            .then((r) => r.items.find((i) => i.code.toLowerCase() === code.toLowerCase()))
            .catch(() => undefined),
        ),
      );
      const known = new Map([...res.items, ...found.filter((i): i is CatalogItem => !!i)].map((i) => [i.id, i]));
      const restored = restoreRows(d.lines, res.results, d.choices, known);
      for (const p of restored.extraItems) known.set(p.id, p);
      setItems(known);
      setRows(restored.rows);
      setNotes(restored.lost ? [...d.notes, `${restored.lost} pilihan di draft ini sudah tidak ada di katalog. Pilih ulang baris yang kosong.`] : d.notes);
      setFileName(d.file_name || "Draft");
      setTitle(d.title);
      setClientId(d.client_id ?? "");
      setDraft(d);
    })()
      .catch((e) => setError(e instanceof Error ? e.message : "Draft tidak bisa dibuka."))
      .finally(() => setBusy(false));
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Saves the review as a draft (new, or over the version it read). Returns the saved draft. */
  const saveDraft = async (quiet = false): Promise<Draft | null> => {
    if (!rows) return null;
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        client_id: clientId === "" ? null : clientId,
        file_name: fileName,
        // The note about lost picks is about this opening, not part of the draft.
        notes: notes.filter((n) => !n.includes("sudah tidak ada di katalog")),
        lines: rows.map((r) => r.request),
        choices: choicesFromRows(rows, items),
      };
      const r = draft
        ? await api.put<{ draft: Draft }>(`/list-drafts/${draft.id}`, { ...body, version: draft.version })
        : await api.post<{ draft: Draft }>("/list-drafts", body);
      setDraft(r.draft);
      onDraftChanged?.();
      if (!quiet) toast("Draft disimpan. Lanjutkan kapan saja dari daftar List klien tersimpan.");
      return r.draft;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Draft gagal disimpan.", "error");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const sendDraft = async (assignedTo: number, note: string, name: string) => {
    const saved = await saveDraft(true);
    if (!saved) return;
    setSaving(true);
    try {
      await api.post(`/list-drafts/${saved.id}/send`, { assigned_to: assignedTo, note });
      onDraftChanged?.();
      toast(`Dikirim ke ${name}. Ia mendapat email dengan tautan ke list ini.`);
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Draft gagal dikirim.", "error");
      setSaving(false);
    }
  };

  const read = async (file?: File | null) => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      // PDF and photos go through the server's OCR; spreadsheets are parsed here.
      const { ocrMimeFor } = await import("../import/ocr");
      const mime = ocrMimeFor(file);
      setStage(mime ? "ai" : "file");
      const { lines, report } = mime
        ? await (await import("../import/ocr")).ocrRequestList(file, mime).then((r) => ({ lines: r.lines, report: { notes: r.notes } }))
        : await (await import("../import/parsers")).parseRequestList(file);
      setStage("match");
      await match(lines, report.notes, file.name);
      if (!title) {
        const client = list.find((c) => c.id === clientId);
        setTitle(client ? `Penawaran ${client.name}` : file.name.replace(/\.[^.]+$/, ""));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "File tidak bisa dibaca.");
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, bulk: false, ...patch } : r)));

  const lines = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => {
      const item = r.chosen != null ? items.get(r.chosen) : undefined;
      // Nothing chosen: the client's own line stays on the quote, held, so all of their list shows.
      if (!item) {
        return {
          id: `req-${Math.random().toString(36).slice(2, 9)}`,
          lineNo: 0,
          code: "",
          name: r.request.name,
          uom: r.request.uom?.trim() || "Pcs",
          qty: Math.max(1, Number(r.request.qty) || 1),
          cogs: 0,
          rrp: 0,
          role: "CORE" as const,
          estCogs: true,
          unmatched: true,
          held: true,
          holdReason: "unmatched" as const,
        };
      }
      // A PO without a unit column still says "(isi 12/Lusin)" in the name: read it, so 173 lusin
      // become 2.076 Pcs and the ceiling per lusin is divided by 12. "Tanpa qty" rows stay in the base unit.
      const line = lineFromCatalog(item, r.request.qty ?? 1, {
        uom: r.request.uom,
        rrp: r.request.rrp,
        requestName: r.request.noQty ? undefined : r.request.name,
        toBase: true,
      });
      // "Barang baru" is not in the catalog yet, so its line waits for Accurate
      // (shared/pendingItems.ts). The server holds it on every read as well.
      if (item.source === "pending") {
        // With a typed price the line goes on the document now as a plain manual line
        // (no code, so the server does not hold it); without one it waits for Accurate.
        const p = Math.round(Number(item.list_price) || 0);
        return p > 0
          ? { ...line, code: "", rrp: p, rrpDefault: false, manualPrice: [p, p, p] }
          : { ...line, held: true, holdReason: "new_item" as const };
      }
      // A catalog item with a bad COGS goes on the quote held (server/cogsCheck.ts):
      // not offered or totalled until a manager checks it, but not forgotten.
      return item.cogs_problem ? { ...line, held: true } : line;
    });
  }, [rows, items]);

  // Prices for staff: the same lines the quote will be built from, priced by
  // the server without saving anything. Index i -> unit price.
  const [prices, setPrices] = useState<Record<number, number>>({});
  const previewKey = JSON.stringify(lines.map((l) => l && [l.code, l.qty, l.uom, l.rrp]));
  useEffect(() => {
    if (seeCosts || !rows) return;
    const send = lines
      .map((l, i) => l && l.holdReason !== "unmatched" && { id: `r${i}`, code: l.code, name: l.name, qty: l.qty, uom: l.uom, rrp: l.rrp })
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
  // A unit read from the client's wording ("isi 12/Lusin") changes the cost of the line by 12x or more,
  // and the catalog's ratios change over time: the rep confirms it once per row, whatever the matcher thought.
  const unitCheck = (r: Row) => {
    const item = r.chosen != null ? items.get(r.chosen) : undefined;
    if (!item || r.request.noQty) return false;
    // A unit without a ratio was counted as one base unit: the rep says whether that's right.
    return r.request.uom ? !!unitAssumed(r.request.uom, item) : packUnitNeedsCheck(r.request.name, item);
  };
  const settled = (r: Row) => r.confirmed && (!unitCheck(r) || r.unitOk);
  // Staff must confirm every match before the quote exists; a manager/admin (skip_match_review) may create it
  // with some unconfirmed and fix them in the editor, where every line is editable.
  const pending = rows?.filter((r) => r.chosen != null && !settled(r)).length ?? 0;
  // Waiting for Accurate = a "barang baru" without a typed price; with one it is a manual line on the document.
  const isPending = (r: Row) => {
    const it = r.chosen != null ? items.get(r.chosen) : undefined;
    return it?.source === "pending" && !(Number(it.list_price) > 0);
  };
  // "Perlu dicek" only because near-equal variants tie (shared/match.ts tie): the first suggestion,
  // untouched, not held and not a barang baru. A row missing a word the client wrote is never in here.
  const bulkable = (r: Row) =>
    !!r.result.tie && !r.confirmed && r.chosen != null && r.chosen === r.result.candidates[0]?.id && !isPending(r) && !blockedOf(r);
  const bulkCount = rows?.filter(bulkable).length ?? 0;
  const acceptAll = () => setRows((rs) => rs && rs.map((r) => (bulkable(r) ? { ...r, confirmed: true, bulk: true } : r)));
  const heldCount = rows?.filter((r) => blockedOf(r) || isPending(r)).length ?? 0;
  const used = lines.filter((l) => l && l.holdReason !== "unmatched").length;
  // Rows with no item and no price: they stay on the quote as "menyusul" (held) and in Perlu diperbaiki.
  const skipped = (rows?.length ?? 0) - used;


  const create = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const quoteItems = (lines.filter(Boolean) as QuoteItem[]).map((l, i) => ({ ...l, lineNo: i + 1 }));
      // Rows that don't go on the quote are kept on "Perlu diperbaiki" (saved
      // with the quote, in the same request), so nothing the client asked for
      // is silently dropped.
      const unmatched = rows
        .filter((row) => row.chosen == null)
        .map((row) => ({
          name: row.request.name.slice(0, 300),
          qty: Math.max(0, Number(row.request.qty) || 0),
          uom: (row.request.uom ?? "").slice(0, 32),
          reason: row.result.status === "none" ? "none" : "skipped",
        }));
      const r = await api.post<{ quote: { id: number } }>("/quotes", {
        title: title.trim(),
        client_id: clientId === "" ? null : clientId,
        snapshot: { items: quoteItems },
        unmatched,
        ...(draft ? { draft_id: draft.id } : {}),
      });
      // Learn the pairings a person actually looked at: the ones that needed a
      // check or were changed. Code matches need no alias; untouched automatic
      // matches are left alone so a wrong guess never hardens into a rule.
      // Only for a chosen client: an alias without one would skip review for
      // every rep and every client, so one hurried "Benar" would become a
      // company-wide rule.
      const pairs = clientId === "" ? [] : rows
        .filter((row) => row.chosen != null && row.result.via !== "code" && !row.bulk)
        // A "barang baru" code (BARU-0001) is replaced once Accurate has the real one,
        // so an alias pointing at it would never match anything.
        .filter((row) => items.get(row.chosen!)?.source !== "pending")
        .filter((row) => row.result.status === "review" || row.result.status === "none" || row.chosen !== row.result.candidates[0]?.id)
        .map((row) => ({ text: row.request.name, code: items.get(row.chosen!)!.code }));
      // Every row is reported, right or wrong, with or without a client: the
      // pairs above become rules, this is the evidence behind the learning
      // report (shared/matchLearning.ts). Without it nothing was ever recorded.
      const feedback = rows.filter((row) => !row.bulk).map((row) => {
        const item = row.chosen != null ? items.get(row.chosen) : undefined;
        const suggested = row.result.candidates[0] ? (items.get(row.result.candidates[0].id)?.code ?? null) : null;
        return {
          text: row.request.name,
          status: row.result.status,
          via: row.result.via ?? "",
          suggested,
          score: row.result.candidates[0]?.score ?? 0,
          chosen: item?.code ?? null,
          isNew: item?.source === "pending",
        };
      });
      if (pairs.length || feedback.length) {
        await api
          .post("/catalog/aliases", { client_id: clientId === "" ? null : clientId, pairs, feedback })
          .catch(() => toast("Quotation dibuat, tetapi pasangan nama-katalog gagal disimpan untuk lain kali.", "error"));
      }
      if (draft) onDraftChanged?.();
      onCreated(r.quote.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal membuat quotation.", "error");
      setBusy(false);
    }
  };

  // What each row's status column says now; the header counts the same thing, so it cannot
  // keep "1 adjustment" after the rep has settled that row.
  const rowState = (row: Row): RowState => ({
    status: row.result.status,
    chosen: row.chosen != null,
    confirmed: settled(row),
    pending: isPending(row),
    held: !!blockedOf(row),
  });
  const summary = rows && reviewSummary(rows.map(rowState));

  return (
    <Modal
      title="Quotation dari list klien"
      sub={draftId ? "Draft tersimpan. Setiap baris dicocokkan ulang ke katalog hari ini; pilihan Anda sebelumnya dipulihkan." : initial ? "Daftar dari chat. Setiap baris dicocokkan ke katalog; harga diambil dari database." : "Upload daftar kebutuhan klien. Setiap baris dicocokkan ke katalog; harga dan COGS diambil dari database."}
      size={rows ? "full" : "normal"}
      onClose={onClose}
      footer={
        rows ? (
          <>
            <span className="grow muted small">
              {used} item masuk{skipped ? ` · ${skipped} menyusul (belum ada di katalog; tetap tampil di quotation, dicatat di Perlu diperbaiki)` : ""}
              {pending ? (skipReview ? ` · ${pending} belum dicek (bisa diedit di quotation)` : ` · ${pending} perlu dicek dulu`) : ""}
              {heldCount ? ` · ${heldCount} ditahan (COGS dicek manajer)` : ""}
            </span>
            {initial ? (
              <button className="btn ghost" onClick={onClose} disabled={busy}>Kembali ke chat</button>
            ) : (
              !draft && <button className="btn ghost" onClick={() => setRows(null)} disabled={busy}>Ganti file</button>
            )}
            <button className="btn" onClick={() => void saveDraft()} disabled={busy || saving}>
              {saving ? "Menyimpan…" : "Simpan"}
            </button>
            <button className="btn" onClick={() => setSending(true)} disabled={busy || saving || sending}>
              Kirim ke PIC…
            </button>
            <button className="btn primary" onClick={create} disabled={busy || saving || !rows?.length || (pending > 0 && !skipReview) || !title.trim()}>
              {busy ? "Membuat…" : `Buat quotation (${used} item${skipped ? ` + ${skipped} menyusul` : ""})`}
            </button>
          </>
        ) : (
          <button className="btn ghost" onClick={onClose}>Batal</button>
        )
      }
    >
      {!rows && (initial || draftId) ? (
        // A list from chat or a saved draft has no file step: just the wait for matching, or why it failed.
        <div className="form-stack">
          {busy && <WaitingLine lines={WAITING.match} />}
          {error && <p className="notice error">{error}</p>}
        </div>
      ) : !rows ? (
        <div className="form-stack">
          {adding ? (
            <ClientQuickAdd clients={list} onDone={chooseClient} onCancel={() => setAdding(false)} />
          ) : (
            <div className="picker">
              <label className="field">
                <span>Klien</span>
                <select
                  className="select"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value === "" ? "" : Number(e.target.value))}
                >
                  <option value="">Tanpa klien</option>
                  {list.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <button className="btn ghost" onClick={() => setAdding(true)}>
                Klien baru
              </button>
            </div>
          )}
          <p className="field-help">
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
            <div>
              <strong>Tarik file daftar klien ke sini</strong>
              <div className="muted small">
                Excel, PDF, atau foto. Cukup nama barang dan qty; kode, satuan, dan harga maksimal dipakai kalau ada.
              </div>
            </div>
            <label className="btn" aria-disabled={busy}>
              {busy ? "Memproses…" : "Pilih file"}
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,application/pdf,image/*"
                hidden
                disabled={busy}
                onChange={(e) => void read(e.target.files?.[0])}
              />
            </label>
          </div>
          {busy && <WaitingLine lines={WAITING[stage]} />}
          {error && <p className="notice error">{error}</p>}
        </div>
      ) : (
        <div className="form-stack">
          <div className="ltq-head">
            <label className="field">
              <span>Judul quotation</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="badge-row">
              <span className="badge grey">{fileName}</span>
              <span className="badge green">{summary!.sure} cocok</span>
              {summary!.review > 0 && <span className="badge amber">{summary!.review} perlu dicek</span>}
              {bulkCount > 0 && (
                <button
                  className="btn small"
                  onClick={acceptAll}
                  title="Untuk baris yang saran pertamanya sudah cocok semua kata, hanya ada varian lain yang mirip. Baris yang diterima di sini tidak disimpan sebagai istilah klien."
                >
                  Terima {bulkCount} saran
                </button>
              )}
              {summary!.none > 0 && <span className="badge blue">{summary!.none} adjustment</span>}
              {heldCount > 0 && <span className="badge amber">{heldCount} ditahan</span>}
            </div>
          </div>
          {draft?.assigned_to != null && (
            <p className="notice info">
              Draft dari {draft.created_by_name}
              {draft.assigned_to_name ? `, PIC: ${draft.assigned_to_name}` : ""}
              {draft.assign_note ? `. Catatan: ${draft.assign_note}` : ""}
            </p>
          )}
          {sending && (
            <SendToPic
              busy={saving}
              current={draft?.assigned_to ?? null}
              onCancel={() => setSending(false)}
              onSend={(id, note, name) => void sendDraft(id, note, name)}
            />
          )}
          {notes.map((n) => (
            <p key={n} className="notice info">{n}</p>
          ))}

          {newItemRow !== null && rows?.[newItemRow] && (
            <NewItemForm
              uomOptions={uomOptions}
              initialName={rows[newItemRow].request.name}
              fixedQty={rows[newItemRow].request.qty ?? 1}
              onBack={() => setNewItemRow(null)}
              onClose={() => setNewItemRow(null)}
              onCreated={(_line, item) => {
                const at = newItemRow;
                setItems((m) => new Map(m).set(item.id, item));
                // Into `extra` as well, or the dropdown has no option for it and shows
                // "— tidak dipakai —" over a row that does have an item.
                update(at, { chosen: item.id, confirmed: true, unitOk: false, extra: [...rows[at].extra, item.id] });
                setNewItemRow(null);
                toast(`"${item.name}" diminta ke Accurate. Kalau harga jual diisi, baris langsung masuk dokumen; kalau tidak, ditahan sampai barangnya dibuat.`);
              }}
            />
          )}

          <div className="table-wrap ltq-table">
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
                  const badge = reviewRowBadge(rowState(row));
                  const options = [...row.result.candidates.map((c) => c.id), ...row.extra.filter((id) => !row.result.candidates.some((c) => c.id === id))];
                  const scoreOf = new Map(row.result.candidates.map((c) => [c.id, c.score]));
                  const warn = line ? uomWarning(line) : null;
                  const chosenItem = row.chosen != null ? items.get(row.chosen) : undefined;
                  const pack = chosenItem && !row.request.uom && !row.request.noQty ? readPackUnit(row.request.name, chosenItem) : {};
                  const readUnit = pack.uom && chosenItem && !sameUom(pack.uom, chosenItem.uom || "Pcs") ? pack.uom : null;
                  return (
                    <tr key={i} className={row.chosen == null ? "is-unused" : undefined}>
                      <td className="l muted">{i + 1}</td>
                      <td className="l">
                        <div className="cell-title">{row.request.name}</div>
                        <div className="muted small">
                          {[row.request.code, row.request.noQty ? "Tanpa qty: 1 per satuan terkecil" : row.request.uom]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </div>
                        {readUnit && <div className="muted small">Satuan dibaca dari teks: {readUnit}.</div>}
                        {chosenItem && unitAssumed(row.request.uom, chosenItem) && (
                          <div className="cell-warn">Rasio {row.request.uom} belum ada di katalog: dianggap 1 {row.request.uom} = 1 {chosenItem.uom || "Pcs"}. Kalau isinya lebih, ubah qty atau isi rasionya di Katalog.
                          </div>
                        )}
                        {line && chosenItem && !line.priceUom && line.qty !== (row.request.qty ?? 1) && (
                          <div className="muted small">
                            Dikonversi ke satuan terkecil: {grp(row.request.qty ?? 1)} {row.request.uom || readUnit} = {grp(line.qty)} {line.uom}
                          </div>
                        )}
                        {chosenItem?.last_sale && !row.request.rrp && (
                          <div className="muted small">
                            Harga maksimal dari {chosenItem.last_sale.invoiceNo} ({chosenItem.last_sale.date}), harga terakhir ke{" "}
                            {chosenItem.last_sale.ownClient ? "klien ini" : "klien lain"}
                          </div>
                        )}
                        {pack.conflict && chosenItem && (
                          <div className="cell-warn">Teks menyebut isi {pack.conflict.text} per {pack.conflict.word}, katalog mencatat 1 {pack.conflict.word} = {pack.conflict.catalog}. Satuan tidak diubah: COGS dihitung per {chosenItem.uom || "Pcs"}. Periksa satuan dan rasio.
                          </div>
                        )}
                        {pack.unmatched && chosenItem && (
                          <div className="cell-warn">Teks menyebut {pack.unmatched}, tapi barang ini tidak punya satuan itu: COGS dihitung per {chosenItem.uom || "Pcs"}. Periksa satuan.
                          </div>
                        )}
                      </td>
                      <td className="num">{grp(row.request.qty ?? 1)}</td>
                      <td className="l ltq-pick">
                        <div className="picker-row">
                          <select
                            className="select"
                            aria-label={`Item katalog untuk ${row.request.name}`}
                            value={row.chosen ?? ""}
                            onChange={(e) =>
                              update(i, { chosen: e.target.value === "" ? null : Number(e.target.value), confirmed: true, unitOk: false })
                            }
                          >
                            <option value="">— tidak dipakai —</option>
                            {options.map((id) => {
                              const it = items.get(id);
                              if (!it) return null;
                              const score = scoreOf.get(id);
                              return (
                                <option key={id} value={id}>
                                  {it.name}{shownCode(it.code) ? ` (${shownCode(it.code)})` : ""}{score != null && score < 1 ? ` · ${Math.round(score * 100)}%` : ""}
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
                          <button
                            className="icon-btn"
                            title="Barang baru: belum ada di katalog"
                            aria-label={`Buat barang baru untuk ${row.request.name}`}
                            onClick={() => setNewItemRow(i)}
                          >
                            <Icon name="plus" size={15} />
                          </button>
                        </div>
                        {searchRow === i && (
                          <CatalogSearch
                            initial={row.request.name}
                            seeCosts={seeCosts}
                            onPick={(it) => {
                              setItems((m) => new Map(m).set(it.id, it));
                              update(i, { chosen: it.id, confirmed: true, unitOk: false, extra: [...row.extra, it.id] });
                              setSearchRow(null);
                            }}
                          />
                        )}
                        {row.result.via === "alias" && (
                          <div className="muted small">Dari pilihan sebelumnya untuk istilah ini</div>
                        )}
                        {row.result.via === "si" && (
                          <div className="muted small">
                            Dari faktur penjualan: nama ini pernah difakturkan sebagai barang ini
                            {row.result.status === "review" ? " (ke klien lain, cek dulu)" : " ke klien ini"}
                          </div>
                        )}
                        {warn && <div className="cell-warn">{warn}</div>}
                        {blockedOf(row) && (
                          <div className="cell-warn">{blockedOf(row)}. Masuk sebagai baris ditahan: tidak ikut total dan dokumen sampai dicek manajer.
                          </div>
                        )}
                      </td>
                      <td className="l">
                        {badge.kind === "confirm" ? (
                          <button
                            className="btn small"
                            onClick={() => update(i, { confirmed: true, unitOk: true })}
                            aria-label={`Benar, pakai saran untuk ${row.request.name}`}
                          >
                            Benar
                          </button>
                        ) : (
                          <span className={`badge ${badge.cls}`}>{badge.text}</span>
                        )}
                      </td>
                      <td className="num">
                        {!line ? (
                          <span className="muted">—</span>
                        ) : line.held && !seeCosts ? (
                          <span className="muted">ditahan</span>
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
function CatalogSearch({
  initial,
  seeCosts,
  onPick,
}: {
  initial: string;
  /** PE-1: the server strips cogs for a rep, so the chip must not print it either. */
  seeCosts: boolean;
  onPick: (item: CatalogItem) => void;
}) {
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
    <div className="cell-stack inline-search">
      <form
        className="picker-row"
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
          {it.name}{" "}
          <span className="muted">
            {/* A rep gets no cogs from the server; grp(undefined) printed "COGS 0" on items that
                have one. The unit is what they need to pick the right row anyway. */}
            · {it.code} · {seeCosts ? `COGS ${grp(it.cogs)}` : it.uom || "Pcs"}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Picks the PIC a draft goes to, with an optional note for them. */
function SendToPic({
  busy,
  current,
  onCancel,
  onSend,
}: {
  busy: boolean;
  current: number | null;
  onCancel: () => void;
  onSend: (userId: number, note: string, name: string) => void;
}) {
  const { user } = useAuth();
  const [users, setUsers] = useState<{ id: number; name: string; role: string }[]>([]);
  const [to, setTo] = useState<number | "">(current ?? "");
  const [note, setNote] = useState("");
  useEffect(() => {
    api
      .get<{ users: { id: number; name: string; role: string }[] }>("/list-drafts/users")
      .then((r) => setUsers(r.users.filter((u) => u.id !== user?.id)))
      .catch(() => setUsers([]));
  }, [user?.id]);
  const target = users.find((u) => u.id === to);
  return (
    <div className="card send-pic">
      <div className="inline-form">
        <label className="field">
          <span>Kirim ke PIC</span>
          <select className="select" value={to} onChange={(e) => setTo(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">— pilih orang —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>Catatan untuk PIC (opsional)</span>
          <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Misal: tolong selesaikan hari ini" />
        </label>
        <div className="form-actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Batal</button>
          <button className="btn primary" disabled={busy || !target} onClick={() => target && onSend(target.id, note.trim(), target.name)}>
            {busy ? "Mengirim…" : "Simpan & kirim"}
          </button>
        </div>
      </div>
      <p className="field-help">
        List disimpan dulu, lalu PIC mendapat email berisi tautan. Ia membuka list ini persis seperti sekarang dan bisa langsung membuat quotation.
      </p>
    </div>
  );
}
