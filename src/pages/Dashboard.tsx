import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { ClientQuickAdd } from "../components/ClientQuickAdd";
import { LoadError } from "../components/LoadError";
import { Icon } from "../components/Icon";
import { ListToQuote } from "../components/ListToQuote";
import { ListDrafts } from "../components/ListDrafts";
import { ChatHome } from "../components/ChatHome";
import { RoleTasks } from "../components/RoleTasks";
import { Modal } from "../components/Modal";
import { StatusChip } from "../components/pricing";
import { fmtDateTime, pct, rp } from "@shared/format";
import type { Client, QuoteStatus } from "@shared/types";
import type { DraftSummary } from "@shared/listDrafts";

interface QuoteRow {
  id: number;
  number: string;
  title: string;
  client_name: string | null;
  status: QuoteStatus;
  scenario: number;
  rev_no: number;
  created_by_name: string;
  /** Made by or reassigned to the viewer (server/worker/routes/quotes.ts). */
  mine: boolean;
  updated_at: string;
  item_count: number;
  monthly_value: number;
  net_margin: number;
}

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Semua" },
  { key: "draft", label: "Draft" },
  { key: "submitted", label: "Menunggu" },
  { key: "rejected", label: "Ditolak" },
  { key: "approved", label: "Disetujui" },
  { key: "sent", label: "Terkirim" },
  { key: "won", label: "Menang" },
  { key: "lost", label: "Kalah" },
  { key: "completed", label: "Selesai" },
];

export function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user, can } = useAuth();
  // Staff never receive margins (PE-1).
  const seeCosts = can("view_costs");
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [filter, setFilter] = useState("all");
  // Sales start on their own quotes; managers see the whole team (docs/ui-standar.md).
  const isManager = can("decide_quotes");
  const [mine, setMine] = useState(!isManager);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fromList, setFromList] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const userIdFilter = searchParams.get("user_id");
  // ?draft=12 (the link in the PIC's email) opens that saved list.
  const draftParam = Number(searchParams.get("draft")) || null;
  const [openDraft, setOpenDraft] = useState<number | null>(draftParam);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const loadDrafts = useCallback(() => {
    api
      .get<{ drafts: DraftSummary[] }>("/list-drafts")
      .then((r) => setDrafts(r.drafts))
      .catch(() => setDrafts([]));
  }, []);
  useEffect(loadDrafts, [loadDrafts]);
  const closeDraft = () => {
    setOpenDraft(null);
    if (searchParams.has("draft")) {
      const next = new URLSearchParams(searchParams);
      next.delete("draft");
      setSearchParams(next, { replace: true });
    }
  };
  const userNameFilter = searchParams.get("user_name");

  const clearUserFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("user_id");
    next.delete("user_name");
    setSearchParams(next, { replace: true });
  };

  // Only the newest load may write: an older, slower request must not overwrite it.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    // Every status comes back (the list is not paged), so the tabs filter and
    // count in the browser and the KPIs stay the same whichever tab is open.
    const params = new URLSearchParams();
    if (mine) params.set("mine", "1");
    if (userIdFilter) params.set("user_id", userIdFilter);
    api
      .get<{ quotes: QuoteRow[] }>(`/quotes?${params}`)
      .then((r) => {
        if (seq === loadSeq.current) setQuotes(r.quotes);
      })
      .catch((e) => seq === loadSeq.current && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => seq === loadSeq.current && setLoading(false));
  }, [mine, userIdFilter, toast]);

  useEffect(load, [load]);
  useEffect(() => {
    api
      .get<{ clients: Client[] }>("/clients")
      .then((r) => setClients(r.clients))
      .catch(() => undefined);
  }, []);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return quotes;
    return quotes.filter(
      (x) =>
        x.title.toLowerCase().includes(q) ||
        x.number.toLowerCase().includes(q) ||
        (x.client_name ?? "").toLowerCase().includes(q),
    );
  }, [quotes, query]);
  const counts = useMemo(() => {
    const n: Record<string, number> = { all: searched.length };
    for (const q of searched) n[q.status] = (n[q.status] ?? 0) + 1;
    return n;
  }, [searched]);
  const visible = filter === "all" ? searched : searched.filter((q) => q.status === filter);

  const taskQuotes = isManager ? quotes : quotes.filter((q) => q.mine);
  const kpi = useMemo(() => {
    const active = quotes.filter((q) => ["approved", "sent"].includes(q.status));
    const pipeline = active.reduce((s, q) => s + q.monthly_value, 0);
    const won = quotes.filter((q) => q.status === "won");
    const wonValue = won.reduce((s, q) => s + q.monthly_value, 0);
    const decided = quotes.filter((q) => q.status === "won" || q.status === "lost").length;
    const margins = quotes.filter((q) => q.monthly_value > 0).map((q) => q.net_margin);
    return {
      pipeline,
      wonValue,
      winRate: decided ? won.length / decided : 0,
      avgMargin: margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0,
    };
  }, [quotes]);

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Quotation</h1>
          <p>
            Selamat datang, {user?.name.split(" ")[0]}.{" "}
            {mine ? "Quotation yang Anda buat atau ditugaskan ke Anda." : "Ringkasan quotation seluruh tim."}
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setFromList(true)}>
            Dari list klien
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            Quotation baru
          </button>
        </div>
      </div>

      {!loadError && (
      <div className="overview">
        <RoleTasks
          // From the whole list, not the search box: a typed search must not hide work.
          // A rep's tasks are their own quotes even with "Punya saya" off; a manager's span the team.
          counts={{
            draft: taskQuotes.filter((q) => q.status === "draft").length,
            rejected: taskQuotes.filter((q) => q.status === "rejected").length,
            approved: taskQuotes.filter((q) => q.status === "approved").length,
            submitted: taskQuotes.filter((q) => q.status === "submitted").length,
          }}
          onTab={(status) => {
            // The tab must show the same quotes the count came from.
            if (!isManager) setMine(true);
            setQuery("");
            setFilter(status);
            document.getElementById("quote-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />

        <section className="overview-stats" aria-label={mine ? "Hasil saya" : "Hasil tim"}>
          <h2 className="overview-title">{mine ? "Hasil saya" : "Hasil tim"}</h2>
          <dl className="stat-grid">
            <div className="stat">
              <dt>Pipeline aktif per bulan</dt>
              <dd className="num">{rp(kpi.pipeline)}</dd>
              <dd className="stat-foot">Disetujui dan terkirim</dd>
            </div>
            <div className="stat">
              <dt>Nilai dimenangkan</dt>
              <dd className="num">{rp(kpi.wonValue)}</dd>
              <dd className="stat-foot">Per bulan</dd>
            </div>
            <div className="stat">
              <dt>Tingkat menang</dt>
              <dd className="num">{pct(kpi.winRate, 0)}</dd>
              <dd className="stat-foot">Dari yang sudah diputus</dd>
            </div>
            {seeCosts && (
              <div className="stat">
                <dt>Rata-rata net margin</dt>
                <dd className="num">{pct(kpi.avgMargin)}</dd>
                <dd className="stat-foot">{mine ? "Quotation saya" : "Semua quotation"}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>
      )}

      <div className="dash-row">
        <ListDrafts drafts={drafts} onOpen={setOpenDraft} onChanged={loadDrafts} />
        <ChatHome />
      </div>

      {userIdFilter && (
        <div className="badge blue filter-chip">
          Difilter ke pengguna: {userNameFilter || `#${userIdFilter}`}
          <button className="icon-btn" onClick={clearUserFilter} aria-label="Hapus filter pengguna">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      <div className="card" id="quote-list">
        <div className="tabs card-tabs" role="group" aria-label="Filter status penawaran">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? "on" : ""} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {!loading && !loadError && <span className="tab-count num">{counts[f.key] ?? 0}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <input
            className="input toolbar-search"
            type="search"
            placeholder="Cari nomor, judul, klien"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Cari quotation"
          />
          <label className="toggle">
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => {
                  setMine(e.target.checked);
                  if (e.target.checked && userIdFilter) clearUserFilter();
                }}
              />
              <span>Punya saya</span>
          </label>
          <span className="grow" />
          {!loading && !loadError && <span className="muted small num">{visible.length} quotation</span>}
        </div>

        {loadError ? (
          <LoadError message={loadError} onRetry={load} />
        ) : loading ? (
          <div className="card-body skeleton-list" role="status" aria-label="Memuat quotation…">
            {[0, 1, 2, 3, 4].map((i) => <span key={i} className="skeleton" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="card-body empty">
            <h3>Belum ada quotation di sini</h3>
            <p>Buat quotation baru, lalu isi itemnya dari katalog atau file Excel klien.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>
              Quotation baru
            </button>
          </div>
        ) : (
          <div className="table-wrap flush">
            <table className="table stack">
              <thead>
                <tr>
                  <th className="l">Nomor</th>
                  <th className="l">Judul</th>
                  <th className="l">Klien</th>
                  <th className="l">Status</th>
                  <th>Item</th>
                  <th>Nilai/bulan</th>
                  {seeCosts && <th>Net margin</th>}
                  <th className="l">Dibuat oleh</th>
                  <th className="l">Diubah</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((q) => (
                  <tr key={q.id} className="clickable" onClick={() => navigate(`/quotes/${q.id}`)}>
                    <td className="l num nowrap stack-title">
                      {/* The row is clickable for mouse users; the link is what keyboard
                          and screen-reader users (and ctrl/middle-click) can reach. */}
                      <Link to={`/quotes/${q.id}`} className="row-link" onClick={(e) => e.stopPropagation()}>
                        {q.number}
                      </Link>
                      {q.rev_no > 1 && <span className="badge grey rev-badge">rev {q.rev_no}</span>}
                    </td>
                    <td className="l" data-label="Judul">{q.title}</td>
                    <td className="l" data-label="Klien">{q.client_name ?? <span className="muted">—</span>}</td>
                    <td className="l stack-action"><StatusChip status={q.status} /></td>
                    <td className="num" data-label="Item">{q.item_count}</td>
                    <td className="num" data-label="Nilai / bulan">{rp(q.monthly_value)}</td>
                    {seeCosts && (
                      <td className="num" data-label="Net margin">
                        {/* Colour is never the only sign (WCAG 1.4.1): a low margin also says so. */}
                        {q.net_margin < 0.15 ? (
                          <span className="text-err" title="Di bawah batas net margin 15%">
                            {pct(q.net_margin)} <span className="small">rendah</span>
                          </span>
                        ) : (
                          pct(q.net_margin)
                        )}
                      </td>
                    )}
                    <td className="l muted" data-label="Dibuat oleh">{q.created_by_name}</td>
                    <td className="l muted nowrap" data-label="Diubah">{fmtDateTime(q.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {fromList && (
        <ListToQuote
          clients={clients}
          onClose={() => setFromList(false)}
          onClientAdded={(c) => setClients((l) => [...l, c].sort((a, b) => a.name.localeCompare(b.name)))}
          onCreated={(id) => navigate(`/quotes/${id}`)}
          onDraftChanged={loadDrafts}
        />
      )}

      {openDraft != null && (
        <ListToQuote
          // A new key per draft: the review state belongs to the draft it was opened for.
          key={openDraft}
          clients={clients}
          draftId={openDraft}
          onClose={closeDraft}
          onClientAdded={(c) => setClients((l) => [...l, c].sort((a, b) => a.name.localeCompare(b.name)))}
          onCreated={(id) => navigate(`/quotes/${id}`)}
          onDraftChanged={loadDrafts}
        />
      )}

      {creating && (
        <NewQuoteModal
          clients={clients}
          onClose={() => setCreating(false)}
          onClientAdded={(c) => setClients((l) => [...l, c].sort((a, b) => a.name.localeCompare(b.name)))}
          onCreated={(id) => navigate(`/quotes/${id}`)}
        />
      )}
    </main>
  );
}

function NewQuoteModal({
  clients,
  onClose,
  onCreated,
  onClientAdded,
}: {
  clients: Client[];
  onClose: () => void;
  onCreated: (id: number) => void;
  onClientAdded: (client: Client) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState<number | "">(clients[0]?.id ?? "");
  const [list, setList] = useState(clients);
  const [adding, setAdding] = useState(false);
  const chooseClient = (client: Client, isNew: boolean) => {
    if (isNew) {
      setList((l) => [...l, client].sort((a, b) => a.name.localeCompare(b.name)));
      onClientAdded(client);
    }
    setClientId(client.id);
    setAdding(false);
  };
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ quote: { id: number } }>("/quotes", {
        title: title.trim(),
        client_id: clientId === "" ? null : Number(clientId),
      });
      onCreated(r.quote.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal membuat quotation.", "error");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Quotation baru"
      sub="Nomor dibuat otomatis mengikuti urutan bulan berjalan."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn primary" onClick={create} disabled={busy || adding || !title.trim()}>
            {busy ? "Membuat…" : "Buat dan buka"}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field">
          <span>Judul quotation</span>
          <input
            className="input"
            autoFocus
            placeholder="Kontrak ATK 2026"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
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
      </div>
    </Modal>
  );
}
