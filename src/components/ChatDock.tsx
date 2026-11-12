/* Floating chat, on every page once signed in: a round button at the corner
   that opens the same conversation as the card on the quotation list. */

import { useEffect, useRef } from "react";
import { useChat } from "../context/ChatContext";
import { ChatThread } from "./ChatThread";
import { Icon } from "./Icon";

export function ChatDock() {
  const { open, setOpen, messages, busy, reset } = useChat();
  // Opening moves focus into the panel (on phones the round button that was clicked is hidden).
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  return (
    <div className="no-print">
      {open && (
        <section className="chat-dock card" aria-label="Chat dengan Silvy">
          <div className="card-head">
            <h2>Silvy · asisten quotation</h2>
            <div className="picker-row">
              {messages.length > 0 && (
                <button className="btn small ghost" onClick={reset} disabled={busy}>Baru</button>
              )}
              <button ref={closeRef} className="icon-btn" onClick={() => setOpen(false)} aria-label="Tutup chat">
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
        aria-label={open ? "Tutup chat" : "Buka chat dengan Silvy"}
        aria-expanded={open}
      >
        <Icon name={open ? "x" : "send"} size={20} />
        {!open && messages.length > 0 && <span className="chat-fab-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
