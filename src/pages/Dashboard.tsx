import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { ClientQuickAdd } from "../components/ClientQuickAdd";
import { Icon } from "../components/Icon";
import { ListToQuote } from "../components/ListToQuote";
import { ListDrafts } from "../components/ListDrafts";
import { ChatHome } from "../components/ChatHome";
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
  updated_at: string;
  item_count: number;
  monthly_value: number;
  net_margin: number;
}

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Semua" },
  { key: "draft", label: "Draft" },
  { key: "submitted", label: "Menunggu" },
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
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
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

  const load = useCallback(() => {
    setLoading(true);
    // Every status comes back (the list is not paged), so the tabs filter and
    // count in the browser and the KPIs stay the same whichever tab is open.
    const params = new URLSearchParams();
    if (mine) params.set("mine", "1");
    if (userIdFilter) params.set("user_id", userIdFilter);
    api
      .get<{ quotes: QuoteRow[] }>(`/quotes?${params}`)
      .then((r) => setQuotes(r.quotes))
      .catch((e) => toast(e.message, "error"))
      .finally(() => setLoading(false));
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
      waiting: quotes.filter((q) => q.status === "submitted").length,
    };
  }, [quotes]);

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Quotation</h1>
          <p>
            Selamat datang, {user?.name.split(" ")[0]}. {quotes.length} quotation terlihat oleh Anda.
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setFromList(true)}>
            <Icon name="upload" size={16} />
            Dari list klien
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            Quotation baru
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <div className="label">Pipeline aktif per bulan</div>
          <div className="value num">{rp(kpi.pipeline)}</div>
          <div className="foot">Disetujui dan terkirim</div>
        </div>
        <div className="kpi">
          <div className="label">Nilai dimenangkan</div>
          <div className="value num">{rp(kpi.wonValue)}</div>
          <div className="foot">Per bulan</div>
        </div>
        <div className="kpi">
          <div className="label">Tingkat menang</div>
          <div className="value num">{pct(kpi.winRate, 0)}</div>
          <div className="foot">Dari yang sudah diputus</div>
        </div>
        {seeCosts && (
          <div className="kpi">
            <div className="label">Rata-rata net margin</div>
            <div className="value num">{pct(kpi.avgMargin)}</div>
            <div className="foot">Semua quotation terlihat</div>
          </div>
        )}
        <div className="kpi">
          <div className="label">Menunggu persetujuan</div>
          <div className="value num">{kpi.waiting}</div>
          <div className="foot">Tertahan di manajer</div>
        </div>
      </div>

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

      <div className="card">
        <div className="tabs card-tabs" role="group" aria-label="Filter status penawaran">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? "on" : ""} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {!loading && <span className="tab-count num">{counts[f.key] ?? 0}</span>}
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
          {!loading && <span className="muted small num">{visible.length} quotation</span>}
        </div>

        {loading ? (
          <div className="card-body skeleton-list" role="status" aria-label="Memuat quotation…">
            {[0, 1, 2, 3, 4].map((i) => <span key={i} className="skeleton" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="card-body empty">
            <Icon name="quote" size={28} />
            <h3>Belum ada quotation di sini</h3>
            <p>Buat quotation baru, lalu isi itemnya dari katalog atau file Excel klien.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>
              Quotation baru
            </button>
          </div>
        ) : (
          <div className="table-wrap flush">
            <table className="table">
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
                    <td className="l num nowrap">
                      {/* The row is clickable for mouse users; the link is what keyboard
                          and screen-reader users (and ctrl/middle-click) can reach. */}
                      <Link to={`/quotes/${q.id}`} className="row-link" onClick={(e) => e.stopPropagation()}>
                        {q.number}
                      </Link>
                      {q.rev_no > 1 && <span className="badge grey rev-badge">rev {q.rev_no}</span>}
                    </td>
                    <td className="l">{q.title}</td>
                    <td className="l">{q.client_name ?? <span className="muted">—</span>}</td>
                    <td className="l"><StatusChip status={q.status} /></td>
                    <td className="num">{q.item_count}</td>
                    <td className="num">{rp(q.monthly_value)}</td>
                    {seeCosts && (
                      <td className="num">
                        <span className={q.net_margin < 0.15 ? "text-err" : undefined}>{pct(q.net_margin)}</span>
                      </td>
                    )}
                    <td className="l muted">{q.created_by_name}</td>
                    <td className="l muted nowrap">{fmtDateTime(q.updated_at)}</td>
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
      <div className="col" style={{ gap: 12 }}>
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
              <Icon name="plus" size={15} /> Klien baru
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
