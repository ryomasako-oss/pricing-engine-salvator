/* Quote lines show the catalog photo of their code. The screen loads it by URL
   (browser-cached); PDF and Excel need the bytes, so exports inline them. */

import { useEffect, useState } from "react";
import { api } from "./api";
import { catalogImageUrl } from "@shared/images";
import type { EngineResult } from "@shared/types";

/** code -> photo URL for the codes that have a catalog photo. */
export function useCatalogImages(codes: string[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = [...new Set(codes.map((c) => c.trim()).filter(Boolean))].sort().join("\n");
  useEffect(() => {
    if (!key) return setUrls({});
    let live = true;
    api
      .post<{ images: Record<string, number> }>("/catalog/images", { codes: key.split("\n") })
      .then((r) => live && setUrls(Object.fromEntries(Object.entries(r.images).map(([code, v]) => [code, catalogImageUrl(code, v)]))))
      // No photos is a fine fallback: the quote itself does not depend on them.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  return urls;
}

/** The lines with their photo set, for display. */
export const withPhotos = <T extends { code: string }>(lines: T[], urls: Record<string, string>): T[] =>
  lines.map((l) => (urls[l.code.trim()] ? { ...l, image: urls[l.code.trim()] } : l));

const toDataUrl = async (url: string): Promise<string | undefined> => {
  try {
    const blob = await (await fetch(url, { credentials: "include" })).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
};

/** The same engine with each photo URL replaced by its data URL; a photo that fails to load is left out. */
export async function inlinePhotos<E extends Pick<EngineResult, "rows">>(engine: E): Promise<E> {
  const urls = [...new Set(engine.rows.map((r) => r.image).filter((u): u is string => !!u && !u.startsWith("data:")))];
  const data = new Map(await Promise.all(urls.map(async (u) => [u, await toDataUrl(u)] as const)));
  return {
    ...engine,
    rows: engine.rows.map((r) => (r.image && data.has(r.image) ? { ...r, image: data.get(r.image) } : r)),
  };
}
