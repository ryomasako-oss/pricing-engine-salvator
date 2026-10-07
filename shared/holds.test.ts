import { describe, expect, it } from "vitest";
import { heldNote, offeredRows } from "./holds";

const rows = [
  { lineNo: 1, name: "A" },
  { lineNo: 2, name: "B", held: true },
  { lineNo: 3, name: "C" },
  { lineNo: 4, name: "D", held: true },
];

describe("document holds", () => {
  it("offers only lines not held, renumbered without gaps", () => {
    expect(offeredRows(rows).map((r) => [r.lineNo, r.name])).toEqual([[1, "A"], [2, "C"]]);
  });
  it("names the held lines in one note, or nothing", () => {
    expect(heldNote(rows)).toBe("2 item menyusul, harganya sedang dikonfirmasi: B, D.");
    expect(heldNote([{ name: "A" }])).toBe("");
  });
});
