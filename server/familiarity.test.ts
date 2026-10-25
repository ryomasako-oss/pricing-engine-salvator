import { describe, expect, it } from "vitest";
import { readFamiliaritySession, type FamiliarityParam, type FamiliarityStore } from "./familiarity";

describe("readFamiliaritySession", () => {
  it("binds at most 100 params per query (D1's limit) for a session with 150 resolved items", async () => {
    const counts: number[] = [];
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1, session_id: 1, line_no: i + 1, raw_text: `item ${i}`, normalized_raw_text: `item ${i}`,
      qty: 1, unit: "Pcs", match_status: "exact", match_via: null, match_score: 1, candidates_json: "[]",
      resolved_action: "verify_item", resolved_item_id: i + 1, resolved_item_code: null, resolved_item_name: null,
      resolved_pending_item_id: null, resolved_by: 1, resolved_at: "2026-10-26",
    }));
    const store: FamiliarityStore = {
      async all<T>(sql: string, ...params: FamiliarityParam[]) {
        counts.push(params.length);
        return (sql.includes("familiarity_session_rows") ? rows : []) as T[];
      },
      async get<T>(sql: string, ...params: FamiliarityParam[]) {
        counts.push(params.length);
        return (sql.includes("familiarity_sessions") ? { id: 1, client_id: null, title: "", source: "text", created_by: 1 } : { total: 150 }) as T;
      },
      async run(_sql: string, ...params: FamiliarityParam[]) {
        counts.push(params.length);
        return { changes: 0, lastId: 0 };
      },
    };
    const view = await readFamiliaritySession(store, 1, { id: 1, role: "rep" });
    expect(view?.rows).toHaveLength(150);
    expect(Math.max(...counts)).toBeLessThanOrEqual(100);
  });
});
