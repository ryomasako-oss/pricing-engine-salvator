-- 2026-10-05: "build a quote straight from the client's list". When a rep
-- confirms that a client's wording ("kertas fotokopi") means a catalog item,
-- the pairing is stored so the next list from that client matches by itself.
-- `alias` is shared/match.ts normalizeText(); client_id 0 = any client (a
-- real client id would otherwise need NULL, which UNIQUE treats as distinct).
-- No FK on code, like catalog_item_uoms: a stale alias is simply ignored.

CREATE TABLE IF NOT EXISTS catalog_aliases (
  alias      TEXT NOT NULL,
  client_id  INTEGER NOT NULL DEFAULT 0,
  code       TEXT NOT NULL,
  created_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (alias, client_id)
);
