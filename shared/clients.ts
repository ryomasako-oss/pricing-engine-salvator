/* ============================================================
   Telling client names apart (2026-10-07: "+ Klien baru" inside the
   quote flows). The same company gets typed many ways: "PT Bahtera Adi
   Jaya", "BAHTERA ADI JAYA PT", "Bahtera Adi Jaya, PT.". A key that drops
   case, punctuation and the legal form lets the server refuse a second copy
   and lets the form point at the one that already exists.
   ============================================================ */

/** Legal-form words that say nothing about which company it is. */
const LEGAL = new Set(["pt", "cv", "ud", "tbk", "persero", "perseroan", "terbatas", "fa", "pd", "koperasi", "yayasan"]);

const words = (name: string) =>
  (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !LEGAL.has(w));

/** "PT Bahtera Adi Jaya" and "BAHTERA ADI JAYA, PT." both -> "adi bahtera jaya". "" when nothing is left. */
export function clientKey(name: string): string {
  return [...new Set(words(name))].sort().join(" ");
}

export interface NamedClient {
  id: number;
  name: string;
}

/**
 * Existing clients that look like the typed name, best first: the same key
 * (score 1), then those sharing most of their words. At most `limit`.
 */
export function similarClients<T extends NamedClient>(name: string, clients: T[], limit = 3): { client: T; score: number }[] {
  const typed = new Set(words(name));
  if (!typed.size) return [];
  const key = clientKey(name);
  return clients
    .map((client) => {
      if (clientKey(client.name) === key) return { client, score: 1 };
      const theirs = new Set(words(client.name));
      if (!theirs.size) return { client, score: 0 };
      const shared = [...typed].filter((w) => theirs.has(w)).length;
      return { client, score: shared / Math.max(typed.size, theirs.size) };
    })
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score || a.client.name.localeCompare(b.client.name))
    .slice(0, limit);
}

/** The client already saved under this name in another spelling, if any (`exceptId`: the one being edited). */
export function sameClient<T extends NamedClient>(name: string, clients: T[], exceptId?: number): T | undefined {
  const key = clientKey(name);
  return key ? clients.find((c) => c.id !== exceptId && clientKey(c.name) === key) : undefined;
}
