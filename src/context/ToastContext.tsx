import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Icon } from "../components/Icon";

type Tone = "info" | "success" | "error";
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const ToastContext = createContext<((text: string, tone?: Tone) => void) | null>(null);

/** Errors stay until dismissed: a 4-second error is easy to miss and gives
    screen-reader users no time to act on it (WCAG 2.2.1). Keep only the most
    recent few so a burst of failures cannot fill the screen. */
const MAX_ERRORS = 3;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (text: string, tone: Tone = "info") => {
      const id = Date.now() + Math.random();
      setToasts((t) => {
        const next = [...t, { id, text, tone }];
        const errors = next.filter((x) => x.tone === "error");
        if (errors.length <= MAX_ERRORS) return next;
        const drop = new Set(errors.slice(0, errors.length - MAX_ERRORS).map((x) => x.id));
        return next.filter((x) => !drop.has(x.id));
      });
      if (tone !== "error") setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);
  const errors = toasts.filter((t) => t.tone === "error");
  const others = toasts.filter((t) => t.tone !== "error");
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="hk-toasts">
        {/* Two live regions: errors interrupt (alert), everything else waits its turn. */}
        <div className="hk-toast-stack" role="alert">
          {errors.map((t) => (
            <div key={t.id} className="hk-toast error">
              <span>{t.text}</span>
              <button type="button" className="hk-toast-close" onClick={() => dismiss(t.id)} aria-label="Tutup pesan">
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="hk-toast-stack" role="status" aria-live="polite">
          {others.map((t) => (
            <div key={t.id} className={`hk-toast ${t.tone}`}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
