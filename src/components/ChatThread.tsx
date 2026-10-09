/* The conversation itself (messages, suggestions, composer), shared by the
   card on the quotation list and the floating panel. State is in ChatContext. */

import { useEffect, useRef, useState } from "react";
import { type ChatMessage, useChat } from "../context/ChatContext";
import { Icon } from "./Icon";
import { WaitingLine } from "./WaitingLine";

const SUGGESTIONS = [
  "Buatkan penawaran untuk PT … : pulpen 10 lusin, kertas A4 5 rim",
  "Klien butuh 20 box klip, 5 lem stik, dan 10 map",
];

// True of what the server does for a chat turn; the last line says what the AI does not do.
const WAITING = [
  "Silvy membaca pesan Anda…",
  "Silvy menyusun daftar barang dan qty…",
  "Mencocokkan nama klien dengan daftar klien…",
  "Silvy hanya menyusun daftar. Harga nanti diambil dari katalog, bukan dari AI.",
];

function Bubble({ m, onReview }: { m: ChatMessage; onReview: (m: ChatMessage) => void }) {
  if (m.role === "user") return <div className="bubble">{m.text}</div>;
  return (
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
          <button className="btn small primary" onClick={() => onReview(m)}>
            Tinjau {m.lines.length} item
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatThread({ maxHeight = 320 }: { maxHeight?: number | string }) {
  const { messages, busy, send, review } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  const submit = (text = input) => {
    if (!text.trim() || busy) return;
    setInput("");
    void send(text);
  };

  return (
    <>
      {messages.length === 0 && (
        <div className="card-body" style={{ paddingBottom: 4 }}>
          <p className="muted small" style={{ margin: "0 0 8px" }}>
            Halo, saya Silvy. Ceritakan kebutuhan klien dengan kata-kata sendiri. Daftar yang tersusun bisa Anda tinjau sebelum jadi quotation;
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
        <div className="chat-scroll" ref={scrollRef} style={{ maxHeight }}>
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <Bubble m={m} onReview={review} />
            </div>
          ))}
          {busy && <WaitingLine lines={WAITING} />}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          rows={1}
          value={input}
          placeholder="Tanya Silvy, mis. untuk PT Maju Jaya: pulpen 10 lusin, kertas A4 5 rim"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Pesan"
        />
        <button className="send" type="submit" disabled={!input.trim() || busy} aria-label="Kirim">
          <Icon name="send" size={17} />
        </button>
      </form>
    </>
  );
}
