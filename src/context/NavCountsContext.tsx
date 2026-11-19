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
  /** Draf Perbaikan Divisi Gudang waiting: all for an admin, one's own for an Admin Gudang. */
  drafts: number | null;
}

const NavCountsContext = createContext<NavCounts>({ pending: null, toFix: null, drafts: null });

export function NavCountsProvider({ children }: { children: React.ReactNode }) {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const [pending, setPending] = useState<number | null>(null);
  const [toFix, setToFix] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<number | null>(null);

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
    if (!can("draft_catalog") && !can("review_catalog_drafts")) return;
    const refresh = () =>
      api.get<{ pending: number }>("/catalog/drafts/count").then((r) => setDrafts(r.pending)).catch(() => undefined);
    refresh();
    window.addEventListener("catalog-drafts-changed", refresh);
    return () => window.removeEventListener("catalog-drafts-changed", refresh);
  }, [can, pathname]);

  return <NavCountsContext.Provider value={{ pending, toFix, drafts }}>{children}</NavCountsContext.Provider>;
}

export const useNavCounts = () => useContext(NavCountsContext);
