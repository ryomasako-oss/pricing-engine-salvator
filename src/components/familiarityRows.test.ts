import { describe, expect, it } from "vitest";
import type { FamiliarityCandidate, FamiliarityRow } from "@shared/familiarity";
import {
  currentPairing,
  feedLines,
  filterRows,
  linesFromPaste,
  mergeRows,
  pillsFor,
  rowMode,
  workbenchCounts,
} from "./familiarityRows";

const cat = (id: number, code: string, name: string, score = 1): FamiliarityCandidate => ({
  source: "catalog", item_id: String(id), pending_item_id: null, code, name, uom: "Pcs", score,
});
const pend = (id: number, code: string, name: string, score = 1): FamiliarityCandidate => ({
  source: "pending", item_id: null, pending_item_id: id, code, name, uom: "Pcs", score,
});

const row = (id: number, raw: string, over: Partial<FamiliarityRow> = {}): FamiliarityRow => ({
  id,
  line_no: id,
  raw_text: raw,
  normalized_raw_text: raw.toLowerCase(),
  qty: 1,
  unit: "",
  status: "adjustment",
  match: { status: "none", via: null, score: 0, item_id: null, pending_item_id: null },
  candidates: [],
  resolved: null,
  ...over,
});

const verified = (id: number, code: string, name: string) => ({
  action: "verify_item" as const, item_id: String(id), pending_item_id: null, code, name, normalized_raw_text: "",
});

describe("filters and the counter", () => {
  const rows = [
    row(1, "kertas sidu", { status: "resolved", candidates: [cat(1, "K-SD70", "KERTAS HVS SINAR DUNIA A4 70GR")], resolved: verified(1, "K-SD70", "KERTAS HVS SINAR DUNIA A4 70GR") }),
    row(2, "lakban", { status: "mirip", candidates: [cat(2, "LKB-48", "LAKBAN BENING 48MM", 0.6)] }),
    row(3, "teh kotak"),
    row(4, "Teh Kotak"),
    row(5, "ITEM DESCRIPTION", { status: "resolved", resolved: { action: "ignore_row", item_id: null, pending_item_id: null, code: null, name: "", normalized_raw_text: "" } }),
    row(6, "spidol snowman", { status: "pasti", candidates: [cat(4, "SP-HTM", "SPIDOL WHITEBOARD SNOWMAN HITAM", 0.9)] }),
  ];

  it("counts what still needs a person, and what is already familiar (a header is settled, not familiar)", () => {
    expect(workbenchCounts(rows)).toEqual({ all: 6, todo: 3, familiar: 1, adjustment: 2, review: 1 });
  });

  it.each([
    ["all", [1, 2, 3, 4, 5, 6]],
    ["todo", [2, 3, 4]],
    ["familiar", [1]],
  ] as const)("%s", (f, ids) => {
    expect(filterRows(rows, f).map((r) => r.id)).toEqual(ids);
  });

  it("a resolve's answer replaces the twins it settled and leaves the rest alone", () => {
    const done = { status: "resolved" as const, resolved: verified(2, "LKB-48", "LAKBAN BENING 48MM") };
    const next = mergeRows(rows, [{ ...rows[2], ...done }, { ...rows[3], ...done }]);
    expect(next.filter((r) => r.resolved?.action === "verify_item").map((r) => r.id)).toEqual([1, 3, 4]);
    expect(workbenchCounts(next)).toMatchObject({ todo: 1, adjustment: 0, familiar: 3 });
    // New array; the old list is not changed under React.
    expect(rows[2].resolved).toBeNull();
  });

  it("modes: unsure rows are todo, a sure guess is auto, anything settled is settled", () => {
    expect(rows.map(rowMode)).toEqual(["settled", "todo", "todo", "todo", "settled", "auto"]);
  });
});

describe("what a row offers", () => {
  const lakban = cat(2, "LKB-48", "LAKBAN BENING 48MM", 0.62);
  const gunting = cat(3, "GNT-KC", "GUNTING KERTAS JOYKO KECIL", 0.4);
  const teh = pend(77, "BARU-0007", "TEH KOTAK SOSRO 300ML", 0.9);

  it("offers the candidates in the server's order, catalog and barang baru alike, at most four", () => {
    const r = row(1, "x", { candidates: [teh, lakban, gunting, cat(5, "A", "A"), cat(6, "B", "B")] });
    expect(pillsFor(r, false).map((c) => c.code)).toEqual(["BARU-0007", "LKB-48", "GNT-KC", "A"]);
  });

  it("when correcting, the pairing in place is not offered again", () => {
    const r = row(1, "lakban", { status: "resolved", candidates: [lakban, gunting], resolved: verified(2, "LKB-48", "LAKBAN BENING 48MM") });
    expect(pillsFor(r, true).map((c) => c.code)).toEqual(["GNT-KC"]);
    expect(currentPairing(r).label).toBe("LAKBAN BENING 48MM (LKB-48)");
  });

  it("a catalog id and a pending id with the same number are different answers", () => {
    const r = row(1, "x", {
      status: "resolved",
      candidates: [pend(2, "BARU-0002", "BARU"), cat(2, "LKB-48", "LAKBAN")],
      resolved: { action: "create_new_item", item_id: null, pending_item_id: 2, code: "BARU-0002", name: "BARU", normalized_raw_text: "" },
    });
    expect(pillsFor(r, true).map((c) => c.code)).toEqual(["LKB-48"]);
  });

  it("unsettled: shows the matcher's best guess, or a dash when it has none", () => {
    expect(currentPairing(row(1, "x", { candidates: [lakban] })).label).toBe("LAKBAN BENING 48MM (LKB-48)");
    expect(currentPairing(row(1, "x")).label).toBe("—");
  });
});

describe("input lines", () => {
  it("a paste drops bullets, numbering and extra spreadsheet cells", () => {
    expect(linesFromPaste("1. Kertas A4\n- Lakban\n\nSpidol\thitam\t12")).toEqual([{ name: "Kertas A4" }, { name: "Lakban" }, { name: "Spidol" }]);
  });

  it("keeps the code apart from the name, as Dari list klien sends it to /catalog/match", () => {
    expect(feedLines([{ code: "100591", name: "CAFE_GARAM 1 KG", uom: "Pcs", qty: 3 }])).toEqual([
      { text: "CAFE_GARAM 1 KG", qty: 3, unit: "Pcs", code: "100591" },
    ]);
  });

  it("drops what the feed would refuse: a negative or missing quantity, blank unit and code", () => {
    expect(feedLines([{ name: "Lakban", qty: -1, uom: " ", code: "" }, { name: "Spidol" }])).toEqual([{ text: "Lakban" }, { text: "Spidol" }]);
  });
});
