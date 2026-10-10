/* The chat card above the quotation list. Same conversation as the floating
   panel (ChatContext); see ChatThread for the thread itself. */

import { useChat } from "../context/ChatContext";
import { ChatThread } from "./ChatThread";

export function ChatHome() {
  const { messages, busy, reset } = useChat();
  return (
    <div className="card chat-home" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Silvy · asisten penawaran</h2>
        {messages.length > 0 && (
          <button className="btn small ghost" onClick={reset} disabled={busy}>Percakapan baru</button>
        )}
      </div>
      <ChatThread />
    </div>
  );
}
