/* Catalog search as you type for the small pickers (Dari list klien, Pencocokan): the shared search
   (GET /catalog → shared/catalogSearch.ts), a page at a time, a slower old answer never replacing a newer one. */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CatalogItem } from "@shared/types";

type Page = { items: CatalogItem[]; total: number; suggestion?: string | null };

export function useCatalogSearch(q: string, pageSize = 30) {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const query = q.trim();

  const fetchPage = useCallback(
    (offset: number) => api.get<Page>(`/catalog?${new URLSearchParams({ q: query, limit: String(pageSize), offset: String(offset) })}`),
    [query, pageSize],
  );

  useEffect(() => {
    const mine = ++seq.current;
    if (!query) {
      setItems(null);
      setTotal(0);
      setSuggestion(null);
      return;
    }
    const t = setTimeout(() => {
      setBusy(true);
      fetchPage(0)
        .then((r) => {
          if (mine !== seq.current) return;
          setItems(r.items);
          setTotal(r.total);
          setSuggestion(r.suggestion ?? null);
        })
        .catch(() => mine === seq.current && setItems([]))
        .finally(() => mine === seq.current && setBusy(false));
    }, 150);
    return () => clearTimeout(t);
  }, [query, fetchPage]);

  const loadMore = useCallback(() => {
    if (busy || !items || items.length >= total) return;
    const mine = seq.current;
    setBusy(true);
    fetchPage(items.length)
      .then((r) => {
        if (mine !== seq.current) return;
        setItems((prev) => [...(prev ?? []), ...r.items.filter((i) => !(prev ?? []).some((p) => p.id === i.id))]);
      })
      .finally(() => mine === seq.current && setBusy(false));
  }, [busy, items, total, fetchPage]);

  return { items, total, suggestion, busy, loadMore };
}
