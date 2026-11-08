/* Lets a page (e.g. the quote editor) block in-app navigation while it has
   unsaved edits. Plain React Router navigation (NavLink clicks) unmounts the
   page directly - it doesn't go through beforeunload - so without this, a
   page with unsaved edits would silently lose them the moment someone clicks
   another nav link. The page only says whether it is dirty (a ref, read from
   click handlers); the question is the app's own dialog, not window.confirm
   (docs/ui-standar.md, Modal). */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ConfirmModal } from "../components/Modal";

type Leave = { go: () => void; stay?: () => void };

const UnsavedGuardContext = createContext<{
  setDirty: (dirty: boolean) => void;
  /** Runs `go` now, or after the person agrees to drop unsaved edits; `stay` if they don't. */
  confirmLeave: (go: () => void, stay?: () => void) => void;
} | null>(null);

export function UnsavedGuardProvider({ children }: { children: React.ReactNode }) {
  const dirtyRef = useRef(false);
  const [asking, setAsking] = useState<Leave | null>(null);

  const value = useRef({
    setDirty: (dirty: boolean) => {
      dirtyRef.current = dirty;
    },
    confirmLeave: (go: () => void, stay?: () => void) => {
      if (dirtyRef.current) setAsking({ go, stay });
      else go();
    },
  }).current;

  return (
    <UnsavedGuardContext.Provider value={value}>
      {children}
      {asking && (
        <ConfirmModal
          title="Tinggalkan halaman?"
          message="Ada perubahan yang belum disimpan. Perubahan itu hilang bila Anda pindah halaman sekarang."
          confirmLabel="Tinggalkan"
          onConfirm={() => {
            setAsking(null);
            dirtyRef.current = false;
            asking.go();
          }}
          onClose={() => {
            setAsking(null);
            asking.stay?.();
          }}
        />
      )}
    </UnsavedGuardContext.Provider>
  );
}

/** Called by a page to say whether it has unsaved edits right now. */
export function useUnsavedGuard(dirty: boolean) {
  const ctx = useContext(UnsavedGuardContext);
  if (!ctx) throw new Error("useUnsavedGuard must be used inside UnsavedGuardProvider");
  useEffect(() => {
    ctx.setDirty(dirty);
    return () => ctx.setDirty(false);
  }, [ctx, dirty]);
}

/** Called by navigation UI before it moves to a new route. */
export function useConfirmLeave() {
  const ctx = useContext(UnsavedGuardContext);
  if (!ctx) throw new Error("useConfirmLeave must be used inside UnsavedGuardProvider");
  return ctx.confirmLeave;
}
