/* One chat for the whole app: the conversation lives here, so it follows the
   user from page to page, and the floating button (ChatDock) and the card on
   the quotation list show the same thread. A list the assistant has put
   together opens the same catalog-matching review an uploaded file uses. */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { uid } from "@shared/format";
import type { RequestLine } from "@shared/match";
import type { Client } from "@shared/types";
import { ListToQuote } from "../components/ListToQuote";
import { useConfirmLeave } from "./UnsavedGuardContext";
import { useToast } from "./ToastContext";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  lines?: RequestLine[];
  client?: string;
}

interface ChatState {
  messages: ChatMessage[];
  busy: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  send: (text: string) => Promise<void>;
  reset: () => void;
  review: (m: ChatMessage) => void;
}

const ChatContext = createContext<ChatState | null>(null);

export function useChat(): ChatState {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside ChatProvider");
  return ctx;
}

/** What the server needs back from a row: the rows as it understands them, without UI-only flags. */
const wire = (l: RequestLine) => ({ name: l.name, code: l.code, qty: l.noQty ? undefined : l.qty, uom: l.uom });

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const toast = useToast();
  const confirmLeave = useConfirmLeave();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [draft, setDraft] = useState<{ lines: RequestLine[]; clientId: number | ""; title: string } | null>(null);
  const loaded = useRef(false);

  // Client names let the assistant tie "untuk PT X" to a real client; loaded once, on first use.
  const loadClients = useCallback(async () => {
    if (loaded.current) return clients;
    loaded.current = true;
    try {
      const r = await api.get<{ clients: Client[] }>("/clients");
      setClients(r.clients);
      return r.clients;
    } catch {
      loaded.current = false;
      return clients;
    }
  }, [clients]);

  useEffect(() => {
    if (open) void loadClients();
  }, [open, loadClients]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;
      const next: ChatMessage[] = [...messages, { id: uid(), role: "user", text: content }];
      setMessages(next);
      setBusy(true);
      try {
        const known = await loadClients();
        const res = await api.post<{ reply: string; lines: RequestLine[]; client?: string }>("/chat", {
          messages: next
            .filter((m) => !m.error)
            .slice(-20)
            .map((m) => ({ role: m.role, content: m.text, ...(m.lines?.length ? { lines: m.lines.map(wire) } : {}) })),
          clients: known.map((c) => c.name).slice(0, 200),
        });
        setMessages([...next, { id: uid(), role: "assistant", text: res.reply, lines: res.lines, client: res.client }]);
      } catch (e) {
        setMessages([...next, { id: uid(), role: "assistant", text: e instanceof Error ? e.message : "Chat gagal.", error: true }]);
      } finally {
        setBusy(false);
      }
    },
    [messages, busy, loadClients],
  );

  const review = useCallback(
    (m: ChatMessage) => {
      const client = clients.find((c) => c.name === m.client);
      setOpen(false);
      setDraft({
        lines: m.lines!,
        clientId: client ? client.id : "",
        title: client ? `Penawaran ${client.name}` : "Penawaran dari chat",
      });
    },
    [clients],
  );

  return (
    <ChatContext.Provider value={{ messages, busy, open, setOpen, send, reset: () => setMessages([]), review }}>
      {children}
      {draft && (
        <ListToQuote
          clients={clients}
          initial={draft}
          onClose={() => setDraft(null)}
          onCreated={(id) => {
            setDraft(null);
            // The quotation exists already; don't throw away unsaved edits on the page behind just to open it.
            if (confirmLeave()) navigate(`/quotes/${id}`);
            else toast("Quotation dibuat. Buka dari daftar quotation setelah menyimpan perubahan di halaman ini.", "success");
          }}
        />
      )}
    </ChatContext.Provider>
  );
}
