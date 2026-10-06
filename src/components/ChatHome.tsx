/* Chat above the quotation list: talk through what a client needs, get the
   list back, then "Tinjau" hands it to the same catalog matching and review
   an uploaded file goes through. The chat never prices anything; prices come
   from the catalog after review (server/chat.ts). History lives in this
   component only: reload and it starts fresh. */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { uid } from "@shared/format";
import type { RequestLine } from "@shared/match";
import type { Client } from "@shared/types";
import { Icon } from "./Icon";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  lines?: RequestLine[];
  client?: string;
}

export interface ChatDraft {
  lines: RequestLine[];
  clientId: number | "";
  title: string;
}

const SUGGESTIONS = [
  "Buatkan penawaran untuk PT … : pulpen 10 lusin, kertas A4 5 rim",
  "Klien butuh 20 box klip, 5 lem stik, dan 10 map",
];

/** What the server needs back from a row: the rows as it understands them, without UI-only flags. */
const wire = (l: RequestLine) => ({ name: l.name, code: l.code, qty: l.noQty ? undefined : l.qty, uom: l.uom });

export function ChatHome({ clients, onReview }: { clients: Client[]; onReview: (draft: ChatDraft) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  const send = async (text = input) => {
    const content = text.trim();
    if (!content || busy) return;
    const next: Message[] = [...messages, { id: uid(), role: "user", text: content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await api.post<{ reply: string; lines: RequestLine[]; client?: string }>("/chat", {
        messages: next
          .filter((m) => !m.error)
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.text, ...(m.lines?.length ? { lines: m.lines.map(wire) } : {}) })),
        clients: clients.map((c) => c.name).slice(0, 200),
      });
      setMessages([...next, { id: uid(), role: "assistant", text: res.reply, lines: res.lines, client: res.client }]);
    } catch (e) {
      setMessages([...next, { id: uid(), role: "assistant", text: e instanceof Error ? e.message : "Chat gagal.", error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const review = (m: Message) => {
    const client = clients.find((c) => c.name === m.client);
    onReview({
      lines: m.lines!,
      clientId: client ? client.id : "",
      title: client ? `Penawaran ${client.name}` : "Penawaran dari chat",
    });
  };

  return (
    <div className="card chat-home" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Tanya atau minta penawaran</h2>
        {messages.length > 0 && (
          <button className="btn small ghost" onClick={() => setMessages([])} disabled={busy}>Percakapan baru</button>
        )}
      </div>
      {messages.length === 0 && (
        <div className="card-body" style={{ paddingBottom: 4 }}>
          <p className="muted small" style={{ margin: "0 0 8px" }}>
            Ceritakan kebutuhan klien dengan kata-kata sendiri. Daftar yang tersusun bisa Anda tinjau sebelum jadi quotation;
            harga selalu diambil dari katalog.
          </p>
          <div className="chips">
            {SUGGESTIONS.map((q) => (
              <button key={q} className="chip" onClick={() => setInput(q)}>{q}</button>
            ))}
          </div>
        </div>
      )}
      {(messages.length > 0 || busy) && (
        <div className="chat-scroll" ref={scrollRef} style={{ maxHeight: 320 }}>
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role === "user" ? (
                <div className="bubble">{m.text}</div>
              ) : (
                <div className={`answer ${m.error ? "error" : ""}`}>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                  {m.lines && m.lines.length > 0 && (
                    <div className="proposal">
                      <strong>{m.lines.length} item tersusun</strong>
                      <ul>
                        {m.lines.slice(0, 8).map((l, i) => (
                          <li key={i}>
                            {l.name}
                            {l.noQty ? "" : ` — ${l.qty}${l.uom ? ` ${l.uom}` : ""}`}
                          </li>
                        ))}
                        {m.lines.length > 8 && <li className="muted">dan {m.lines.length - 8} lainnya</li>}
                      </ul>
                      <button className="btn small primary" onClick={() => review(m)}>
                        Tinjau {m.lines.length} item
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="loading">
              <span className="dots"><i /><i /><i /></span> Menyusun…
            </div>
          )}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={1}
          value={input}
          placeholder="Mis. untuk PT Maju Jaya: pulpen 10 lusin, kertas A4 5 rim"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Pesan"
        />
        <button className="send" type="submit" disabled={!input.trim() || busy} aria-label="Kirim">
          <Icon name="send" size={17} />
        </button>
      </form>
    </div>
  );
}
