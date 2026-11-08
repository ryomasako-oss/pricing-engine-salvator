/* Keeps unsaved quote edits from vanishing. A page says whether it is dirty;
   while it is, every in-app navigation (links, navigate(), browser Back and
   Forward) is held by React Router's blocker and asked about in the app's own
   dialog, and closing or reloading the tab gets the browser's beforeunload
   prompt. Logging out is not a navigation, so it asks through confirmLeave.
   Needs the data router (createBrowserRouter in main.tsx) for useBlocker. */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBlocker, type BlockerFunction } from "react-router-dom";
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

  // Only a move to another page counts: a search-param change on the same page keeps the edits.
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) => dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
      [],
    ),
  );

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const value = useRef({
    setDirty: (dirty: boolean) => {
      dirtyRef.current = dirty;
    },
    confirmLeave: (go: () => void, stay?: () => void) => {
      if (dirtyRef.current) setAsking({ go, stay });
      else go();
    },
  }).current;

  // One dialog for both ways in: a held navigation, or an explicit confirmLeave.
  const open = asking ?? (blocker.state === "blocked" ? { go: () => blocker.proceed?.(), stay: () => blocker.reset?.() } : null);

  return (
    <UnsavedGuardContext.Provider value={value}>
      {children}
      {open && (
        <ConfirmModal
          title="Tinggalkan halaman?"
          message="Ada perubahan yang belum disimpan. Perubahan itu hilang bila Anda pindah halaman sekarang."
          confirmLabel="Tinggalkan"
          onConfirm={() => {
            setAsking(null);
            dirtyRef.current = false;
            open.go();
          }}
          onClose={() => {
            setAsking(null);
            open.stay?.();
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
  // Layout effect: the flag is set before the "Belum disimpan" badge is painted, so no
  // navigation can slip through between seeing the edit and the guard knowing about it.
  useLayoutEffect(() => {
    ctx.setDirty(dirty);
    return () => ctx.setDirty(false);
  }, [ctx, dirty]);
}

/** For leaving that is not a route change (logout), or a navigation that needs a fallback. */
export function useConfirmLeave() {
  const ctx = useContext(UnsavedGuardContext);
  if (!ctx) throw new Error("useConfirmLeave must be used inside UnsavedGuardProvider");
  return ctx.confirmLeave;
}
