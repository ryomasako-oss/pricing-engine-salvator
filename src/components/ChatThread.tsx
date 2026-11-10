/* The conversation itself (messages, suggestions, composer), shared by the
   card on the quotation list and the floating panel. State is in ChatContext. */

import { useEffect, useRef, useState } from "react";
import { type ChatMessage, useChat } from "../context/ChatContext";
import { grp } from "@shared/format";
import { Icon } from "./Icon";
import { WaitingLine } from "./WaitingLine";

const SUGGESTIONS = [
  "Buatkan penawaran untuk PT … : pulpen 10 lusin, kertas A4 5 rim",
  "Klien butuh 20 box klip, 5 lem stik, dan 10 map",
  "Cek stok kertas A4 di katalog",
];

// True of what the server does for a chat turn; the last line says what the AI does not do.
const WAITING = [
  "Silvy membaca pesan Anda…",
  "Silvy menyusun daftar barang dan qty…",
  "Mencocokkan nama klien dengan daftar klien…",
  "Harga, stok, dan COGS selalu diambil dari katalog, bukan dari AI.",
];

function Bubble({ m, onReview }: { m: ChatMessage; onReview: (m: ChatMessage) => void }) {
  if (m.role === "user") return <div className="bubble">{m.text}</div>;
  return (
    <div className={`answer ${m.error ? "error" : ""}`}>
      <div className="pre-wrap">{m.text}</div>
      {m.found && <Found found={m.found} />}
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

function Found({ found }: { found: NonNullable<ChatMessage["found"]> }) {
  if (!found.items.length) return <p className="muted small">Tidak ada barang di katalog yang cocok.</p>;
  const costs = found.items.some((i) => i.cogs !== undefined);
  return (
    <div className="proposal scroll-x">
      <strong>
        {found.total > found.items.length ? `${found.items.length} dari ${grp(found.total)} barang` : `${found.total} barang`} dari katalog
      </strong>
      <table className="table">
        <thead>
          <tr>
            <th className="l">Kode</th>
            <th className="l">Nama</th>
            <th className="l">Satuan</th>
            <th>Stok</th>
            {costs && <th>COGS</th>}
            {found.kind === "cogs_problem" && <th className="l">Masalah</th>}
          </tr>
        </thead>
        <tbody>
          {found.items.map((i) => (
            <tr key={i.code}>
              <td className="l">{i.code}</td>
              <td className="l">{i.name}</td>
              <td className="l">{i.uom}</td>
              <td>{grp(i.stock)}</td>
              {costs && <td>{grp(i.cogs ?? 0)}</td>}
              {found.kind === "cogs_problem" && <td className="l">{i.problem ?? ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
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
        <div className="card-body tight-bottom">
          <p className="note first">
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
          placeholder="Tanya Silvy, mis. pulpen 10 lusin"
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
