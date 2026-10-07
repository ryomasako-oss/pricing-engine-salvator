/* Floating chat, on every page once signed in: a round button at the corner
   that opens the same conversation as the card on the quotation list. */

import { useChat } from "../context/ChatContext";
import { ChatThread } from "./ChatThread";
import { Icon } from "./Icon";

export function ChatDock() {
  const { open, setOpen, messages, busy, reset } = useChat();
  return (
    <div className="no-print">
      {open && (
        <section className="chat-dock card" aria-label="Chat dengan Salvi">
          <div className="card-head">
            <h2>Salvi · asisten penawaran</h2>
            <div className="row" style={{ gap: 6 }}>
              {messages.length > 0 && (
                <button className="btn small ghost" onClick={reset} disabled={busy}>Baru</button>
              )}
              <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Tutup chat">
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
          <ChatThread maxHeight="none" />
        </section>
      )}
      <button
        className={`chat-fab ${open ? "on" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={open ? "Tutup chat" : "Buka chat dengan Salvi"}
        aria-expanded={open}
      >
        <Icon name={open ? "x" : "send"} size={20} />
        {!open && messages.length > 0 && <span className="chat-fab-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
