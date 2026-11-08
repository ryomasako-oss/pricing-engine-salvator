/* Grounded pricing assistant. The model may propose changes but never
   applies them: every action is shown to the user and applied only on
   an explicit click, so the engine stays the single source of truth. */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { Rich } from "./Rich";
import { computeEngine, priceForMargin } from "@shared/engine";
import { calibrateS2, quickPrice } from "@shared/quickPrice";
import { grp, pct, uid } from "@shared/format";
import { isScenarioActionValue } from "@shared/silvyDocs";
import type { Assumptions, QuoteSnapshot, ScenarioIndex } from "@shared/types";

export interface AssistantAction {
  type: "set" | "item" | "scenario" | "margin";
  key?: string;
  /** margin: "overall" (S2 net margin, calibrated) or "items" (every line in S1). */
  scope?: string;
  no?: number;
  field?: string;
  value: unknown;
}

interface DocMeta {
  title: string;
  desc: string;
}

/** Names the part of the quotation data an answer was drawn from. */
const SOURCE_LABEL: Record<string, string> = {
  summary: "Ringkasan",
  policy: "Kebijakan",
  assumptions: "Asumsi",
  items: "Item",
  delivery: "Pengiriman",
};

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  sources?: string[];
  actions?: AssistantAction[];
  followups?: string[];
  applied?: boolean;
}

const KEY_LABEL: Record<string, string> = {
  opex: "Opex",
  targetMargin: "Target margin",
  leaderMargin: "Margin leader",
  profitDiscount: "Diskon item profit",
  rrpDiscount: "Diskon dari RRP",
  marginFloor: "Margin minimum",
  ppn: "PPN",
  step: "Pembulatan harga",
  months: "Durasi kontrak",
  includeLogistics: "Logistik di harga",
};

/** Renders one proposed action as a sentence a salesperson can check. */
function describe(action: AssistantAction, snapshot: QuoteSnapshot): string {
  if (action.type === "set") {
    const key = String(action.key);
    const label = KEY_LABEL[key] ?? key;
    if (key === "includeLogistics") return `${label}: ${action.value ? "nyala" : "mati"}`;
    if (key === "step" || key === "months") return `${label}: ${action.value}`;
    const v = Number(action.value);
    return `${label}: ${pct(v > 1 ? v / 100 : v)}`;
  }
  if (action.type === "item") {
    const item = snapshot.items.find((i) => i.lineNo === Number(action.no));
    if (action.field === "margin") {
      const v = Number(action.value);
      return `${item?.name ?? `Baris ${action.no}`}: margin ${pct(v > 1 ? v / 100 : v)}`;
    }
    return `${item?.name ?? `Baris ${action.no}`}: ${action.field} jadi ${action.value}`;
  }
  if (action.type === "scenario") return `Pakai skenario S${action.value}`;
  if (action.type === "margin") {
    const v = Number(action.value);
    const p = pct(v > 1 ? v / 100 : v);
    return action.scope === "overall" ? `Margin keseluruhan ${p} (kalibrasi S2)` : `Setiap barang margin ${p} (S1)`;
  }
  return "Perubahan tidak dikenali";
}

interface Props {
  snapshot: QuoteSnapshot;
  number: string;
  title: string;
  status: string;
  clientName: string;
  readOnly: boolean;
  onApply: (actions: AssistantAction[]) => void;
}

export function AssistantPanel({
  snapshot, number, title, status, clientName, readOnly, onApply,
}: Props) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"ask" | "docs">("ask");
  const [docs, setDocs] = useState<Record<string, DocMeta>>({});
  const [docBusy, setDocBusy] = useState<string | null>(null);
  const [docOut, setDocOut] = useState<{ kind: string; text: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .get<{ enabled: boolean; docs?: Record<string, DocMeta> }>("/assistant/status")
      .then((r) => {
        setEnabled(r.enabled);
        setDocs(r.docs ?? {});
      })
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }, [input]);

  const context = () => ({
    snapshot,
    number,
    title,
    status,
    clientName,
    sections: { assumptions: true, items: true, delivery: true },
    notes: [],
  });

  const makeDoc = async (kind: string) => {
    if (docBusy) return;
    setDocBusy(kind);
    setDocOut(null);
    try {
      const r = await api.post<{ content: string }>("/assistant/document", { context: context(), kind });
      setDocOut({ kind, text: r.content });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Silvy gagal membuat dokumen.", "error");
    } finally {
      setDocBusy(null);
    }
  };

  const copyDoc = async () => {
    if (!docOut) return;
    try {
      await navigator.clipboard.writeText(docOut.text.replace(/==/g, ""));
      toast("Dokumen disalin.", "success");
    } catch {
      toast("Tidak bisa menyalin. Salin manual dari teks.", "error");
    }
  };

  const send = async (textArg?: string) => {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const history = [...messages, { id: uid(), role: "user" as const, text }];
    setMessages(history);
    setBusy(true);
    try {
      const r = await api.post<{
        answer: string;
        sources?: string[];
        actions: AssistantAction[];
        followups: string[];
      }>("/assistant/ask", {
        context: context(),
        messages: history
          .filter((m) => !m.error)
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.text })),
      });
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text: r.answer,
          sources: r.sources,
          actions: readOnly ? [] : r.actions,
          followups: r.followups,
        },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          error: true,
          text: e instanceof Error ? e.message : "Silvy gagal menjawab.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const apply = (msg: Message) => {
    if (!msg.actions?.length) return;
    onApply(msg.actions);
    setMessages((all) => all.map((m) => (m.id === msg.id ? { ...m, applied: true } : m)));
    toast("Perubahan diterapkan. Jangan lupa simpan.", "success");
  };

  if (enabled === false) {
    return (
      <div className="card-body">
        <p className="notice info">
          Silvy belum aktif. Isi <code>SILVY_URL</code> dan{" "}
          <code>SILVY_SHARED_SECRET</code> di server lalu mulai ulang aplikasi.
        </p>
      </div>
    );
  }

  const suggestions = [
    "Skenario mana yang paling aman untuk margin?",
    "Item apa saja yang mentok di RRP?",
    "Kenapa cross subsidise tetap untung?",
    "Naikkan margin leader jadi 12%",
  ];

  const docKinds = Object.keys(docs);

  return (
    <div className="chat">
      <div className="silvy-head">
        <span className="silvy-mono" aria-hidden="true">S</span>
        <div className="silvy-id">
          <strong>Silvy</strong>
          <span className="muted small">Menjawab hanya dari angka quotation ini</span>
        </div>
        {docKinds.length > 0 && (
          <div className="tabs silvy-tabs" role="tablist" aria-label="Mode Silvy">
            <button role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "on" : ""} onClick={() => setTab("ask")}>Tanya</button>
            <button role="tab" aria-selected={tab === "docs"} className={tab === "docs" ? "on" : ""} onClick={() => setTab("docs")}>Dokumen</button>
          </div>
        )}
      </div>

      {tab === "docs" ? (
        <div className="chat-scroll">
          <p className="muted small">
            Silvy menulis dokumen internal dari angka quotation ini. Hasilnya bukan untuk klien.
          </p>
          <div className="silvy-docs">
            {docKinds.map((k) => (
              <button
                key={k}
                className={`silvy-doc ${docOut?.kind === k ? "on" : ""}`}
                disabled={docBusy !== null}
                onClick={() => void makeDoc(k)}
              >
                <strong>{docs[k].title}</strong>
                <span className="muted small">{docs[k].desc}</span>
              </button>
            ))}
          </div>
          {docBusy && (
            <div className="loading">
              <span className="dots"><i /><i /><i /></span> Silvy menulis {docs[docBusy]?.title.toLowerCase()}…
            </div>
          )}
          {docOut && !docBusy && (
            <div className="silvy-docout">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <strong>{docs[docOut.kind]?.title}</strong>
                <button className="btn small ghost" onClick={() => void copyDoc()}>Salin</button>
              </div>
              <Rich text={docOut.text} />
            </div>
          )}
        </div>
      ) : (
      <>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div>
            <p className="muted small">
              Tanya apa saja soal harga quotation ini, atau minta Silvy mengubah asumsi.
            </p>
            <div className="chips">
              {suggestions.map((q) => (
                <button key={q} className="chip" onClick={() => void send(q)}>{q}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "user" ? (
              <div className="bubble">{m.text}</div>
            ) : (
              <div className={`answer ${m.error ? "error" : ""}`}>
                <Rich text={m.text} />
                {!m.error && m.sources && m.sources.length > 0 && (
                  <p className="silvy-sources">
                    Sumber: {m.sources.map((x) => SOURCE_LABEL[x] ?? x).join(" · ")}
                  </p>
                )}
                {m.actions && m.actions.length > 0 && (
                  <div className="proposal">
                    <strong>{m.applied ? "Sudah diterapkan" : "Usulan perubahan"}</strong>
                    <ul>
                      {m.actions.map((a, i) => (
                        <li key={i}>{describe(a, snapshot)}</li>
                      ))}
                    </ul>
                    {!m.applied && (
                      <button className="btn small primary" onClick={() => apply(m)}>
                        Terapkan ke engine
                      </button>
                    )}
                  </div>
                )}
                {m.followups && m.followups.length > 0 && !busy && (
                  <div className="chips">
                    {m.followups.map((q) => (
                      <button key={q} className="chip" onClick={() => void send(q)}>{q}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="loading">
            <span className="dots"><i /><i /><i /></span> Membaca angka quotation…
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          placeholder="Tanya atau minta ubah, misal: diskon RRP jadi 8%"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Pesan ke Silvy"
        />
        <button className="send" type="submit" disabled={!input.trim() || busy} aria-label="Kirim">
          <Icon name="send" size={17} />
        </button>
      </form>
      </>
      )}
    </div>
  );
}

/** Applies assistant actions to a snapshot, ignoring anything invalid. */
export function applyActions(
  actions: AssistantAction[],
  snapshot: QuoteSnapshot,
): { snapshot: QuoteSnapshot; labels: string[] } {
  const assumptions: Assumptions = { ...snapshot.assumptions };
  const items = snapshot.items.map((i) => ({ ...i }));
  let scenario = snapshot.scenario;
  const labels: string[] = [];

  for (const action of actions) {
    if (!action || typeof action !== "object") continue;

    if (action.type === "set" && action.key && action.key in assumptions) {
      const key = action.key as keyof Assumptions;
      if (key === "includeLogistics") {
        const v = action.value === true || action.value === "true" || action.value === "Y";
        assumptions.includeLogistics = v;
        labels.push(`${KEY_LABEL[key]}: ${v ? "nyala" : "mati"}`);
      } else if (key === "step" || key === "months") {
        const v = Number(action.value);
        if (!Number.isFinite(v) || v <= 0) continue;
        assumptions[key] = key === "step" ? Math.min(100000, Math.round(v)) : Math.min(60, Math.round(v));
        labels.push(`${KEY_LABEL[key]}: ${assumptions[key]}`);
      } else {
        let v = Number(action.value);
        if (!Number.isFinite(v)) continue;
        if (v > 1) v = v / 100;
        v = Math.max(0, Math.min(0.9, v));
        (assumptions[key] as number) = v;
        labels.push(`${KEY_LABEL[key]}: ${pct(v)}`);
      }
    } else if (action.type === "item") {
      const item = items.find((x) => x.lineNo === Number(action.no));
      if (!item) continue;
      if (action.field === "role") {
        const v = String(action.value).toUpperCase();
        if (!["LEADER", "CORE", "PROFIT"].includes(v)) continue;
        labels.push(`${item.name}: role jadi ${v}`);
        item.role = v as typeof item.role;
      } else if (["qty", "cogs", "rrp"].includes(String(action.field))) {
        const v = Number(action.value);
        if (!Number.isFinite(v) || v < 0) continue;
        labels.push(`${item.name}: ${action.field} jadi ${v}`);
        (item as unknown as Record<string, number>)[String(action.field)] = v;
        if (action.field === "cogs") item.estCogs = false;
        if (action.field === "rrp") item.rrpDefault = false; // a ceiling someone set is the client's
      } else if (action.field === "margin") {
        // One line's margin (Ryoma, 2026-11-04): its price in the chosen scenario becomes
        // landed / (1 - margin), rounded up like the engine. Only a ceiling the client stated caps
        // it; a default one (rrpDefault: last sale, catalog price, COGS x 1,4) does not.
        let m = Number(action.value);
        if (!Number.isFinite(m)) continue;
        if (m > 1) m = m / 100;
        if (m < 0 || m >= 0.95) continue;
        const landed = computeEngine(assumptions, items, snapshot.regions ?? []).rows[items.indexOf(item)]?.landed ?? 0;
        if (!(landed > 0)) continue; // no COGS: no margin to price from
        const target = priceForMargin(landed, m, assumptions.step);
        const rrp = Math.round(Number(item.rrp) || 0);
        const price = rrp > 0 && !item.rrpDefault ? Math.min(target, rrp) : target;
        const manual = [...(item.manualPrice ?? [null, null, null])];
        manual[scenario] = price;
        item.manualPrice = manual;
        labels.push(`${item.name}: margin ${pct(m)}, harga ${grp(price)}${price < target ? ` (mentok harga maksimal ${grp(rrp)})` : ""}`);
      }
    } else if (action.type === "margin" && (action.scope === "overall" || action.scope === "items")) {
      let m = Number(action.value);
      if (!Number.isFinite(m)) continue;
      if (m > 1) m = m / 100;
      if (m < 0 || m >= 0.95) continue;
      if (action.scope === "overall") {
        // Cross-subsidise to an overall margin: S2 (shared/quickPrice.ts calibrateS2).
        const r = calibrateS2(items, assumptions, snapshot.regions ?? [], m);
        r.items.forEach((it, i) => (items[i] = it));
        scenario = 1;
        labels.push(
          r.reached
            ? `S2 margin keseluruhan ${pct(r.achieved)}: barang non-leader margin ${pct(r.margin)}`
            : `S2 margin keseluruhan baru ${pct(r.achieved)} (target ${pct(m)} tidak tercapai: banyak barang mentok di plafon klien)`,
        );
      } else {
        // Every line to the margin in S1, like the quick button from COGS (30% at most).
        const r = quickPrice(items, computeEngine(assumptions, items, snapshot.regions ?? []).rows, 0, "cogs", m, assumptions.step);
        r.items.forEach((it, i) => (items[i] = it));
        scenario = 0;
        labels.push(
          `S1 setiap barang margin ${pct(Math.min(m, 0.3))}: ${r.changed} baris` +
            (r.capped ? `, ${r.capped} mentok di plafon klien` : "") +
            (r.skipped ? `, ${r.skipped} dilewati` : ""),
        );
      }
    } else if (action.type === "scenario") {
      const v = Number(action.value);
      if (isScenarioActionValue(v)) {
        scenario = (v - 1) as ScenarioIndex;
        labels.push(`Skenario jadi S${v}`);
      }
    }
  }

  return { snapshot: { ...snapshot, assumptions, items, scenario }, labels };
}
