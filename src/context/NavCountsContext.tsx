import { createContext, useContext, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "./AuthContext";
import type { Approval } from "@shared/types";

/* Approvals waiting and open fix tasks, fetched once per page change and shared
   by the top bar badges and the dashboard's "Perlu tindakan" tiles, so the two
   never disagree and the dashboard adds no requests of its own. */
interface NavCounts {
  /** null until loaded, and always null without decide_quotes. */
  pending: number | null;
  toFix: number | null;
  /** Draf Gudang + laporan duplikat menunggu: semua untuk admin, milik sendiri untuk Admin Gudang. */
  drafts: number | null;
  /** Laporan duplikat menunggu (sudah termasuk di `drafts`). */
  duplicates: number | null;
}

const NavCountsContext = createContext<NavCounts>({ pending: null, toFix: null, drafts: null, duplicates: null });

export function NavCountsProvider({ children }: { children: React.ReactNode }) {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const [pending, setPending] = useState<number | null>(null);
  const [toFix, setToFix] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<number | null>(null);
  const [duplicates, setDuplicates] = useState<number | null>(null);

  // Keep the approvals badge fresh as the user moves around the app.
  useEffect(() => {
    if (!can("decide_quotes")) return;
    api
      .get<{ approvals: Approval[] }>("/approvals?decision=pending")
      .then((r) => setPending(r.approvals.length))
      .catch(() => undefined);
  }, [can, pathname]);

  // "Perlu diperbaiki": open tasks this user can see (staff: their own quotes).
  useEffect(() => {
    const refresh = () =>
      api.get<{ open: number }>("/fix-tasks/count").then((r) => setToFix(r.open)).catch(() => undefined);
    refresh();
    window.addEventListener("fix-tasks-changed", refresh);
    return () => window.removeEventListener("fix-tasks-changed", refresh);
  }, [pathname]);

  useEffect(() => {
    if (!can("draft_catalog") && !can("review_catalog_drafts") && !can("import_catalog")) return;
    // Angka Gudang = draf + laporan duplikat yang menunggu (keduanya di tab "Menunggu ACC").
    const refresh = () =>
      Promise.all([
        api.get<{ pending: number }>("/catalog/drafts/count"),
        api.get<{ open: number }>("/duplicate-reports/count").catch(() => ({ open: 0 })),
      ]).then(([d, dup]) => (setDrafts(d.pending + dup.open), setDuplicates(dup.open))).catch(() => undefined);
    refresh();
    window.addEventListener("catalog-drafts-changed", refresh);
    window.addEventListener("duplicate-reports-changed", refresh);
    return () => {
      window.removeEventListener("catalog-drafts-changed", refresh);
      window.removeEventListener("duplicate-reports-changed", refresh);
    };
  }, [can, pathname]);

  return <NavCountsContext.Provider value={{ pending, toFix, drafts, duplicates }}>{children}</NavCountsContext.Provider>;
}

export const useNavCounts = () => useContext(NavCountsContext);
