import { describe, expect, it } from "vitest";
import { accuracyNote, accuracyOf, isRejection, outcomeOf, weekOf, type LearningReport } from "./matchLearning";
import { matchLines, normalizeText } from "./match";

const CATALOG = [
  { id: 1, code: "A1", name: "KERTAS HVS A4 70GR SINAR DUNIA" },
  { id: 2, code: "A2", name: "KERTAS HVS A4 70GR BOLA DUNIA" },
  { id: 3, code: "B1", name: "SPIDOL WHITEBOARD SNOWMAN HITAM" },
];

describe("outcomeOf: what the rep's decision says about the guess", () => {
  it("names each of the four cases", () => {
    expect(outcomeOf({ suggested: "A1", chosen: "A1" })).toBe("accepted");
    expect(outcomeOf({ suggested: "A1", chosen: "A2" })).toBe("corrected");
    expect(outcomeOf({ suggested: "A1", chosen: null })).toBe("dropped");
    expect(outcomeOf({ suggested: null, chosen: "A2" })).toBe("corrected"); // nothing offered, rep found it
    expect(outcomeOf({ suggested: null, chosen: null })).toBe("dropped");
    expect(outcomeOf({ suggested: "A1", chosen: "BARU-0001", isNew: true })).toBe("new_item");
  });

  it("counts a correction as a rejection of the pairing, but never a dropped row", () => {
    expect(isRejection({ outcome: "corrected", suggested: "A1" })).toBe(true);
    expect(isRejection({ outcome: "corrected", suggested: null })).toBe(false);
    // The rep may simply not be quoting that line; it says nothing about the guess.
    expect(isRejection({ outcome: "dropped", suggested: "A1" })).toBe(false);
    expect(isRejection({ outcome: "accepted", suggested: "A1" })).toBe(false);
  });
});

describe("the penalty changes what the matcher offers", () => {
  const NAME = "KERTAS HVS A4 70GR SINAR DUNIA";
  const line = [{ name: NAME, qty: 1 }];
  // The key is the normalised wording ("70gr" becomes "70g"), never the raw text.
  const key = normalizeText(NAME);

  it("a pairing nobody rejected is auto-accepted", () => {
    const [r] = matchLines(line, CATALOG);
    expect(r.status).toBe("match");
    expect(r.candidates[0].id).toBe(1);
  });

  it("the same pairing, once corrected away, is no longer a certainty but is still offered", () => {
    const rejected = new Map([[key, new Set(["A1"])]]);
    const [r] = matchLines(line, CATALOG, undefined, rejected);
    expect(r.status).not.toBe("match");
    // Still on the list: one correction can itself be the mistake.
    expect(r.candidates.map((c) => c.id)).toContain(1);
    const a1 = r.candidates.find((c) => c.id === 1)!;
    const fresh = matchLines(line, CATALOG)[0].candidates.find((c) => c.id === 1)!;
    expect(a1.score).toBeCloseTo(fresh.score * 0.5, 3);
  });

  it("penalises only the rejected pairing, not the wording and not the item elsewhere", () => {
    const rejected = new Map([[key, new Set(["A2"])]]);
    const [r] = matchLines(line, CATALOG, undefined, rejected);
    expect(r.status).toBe("match");
    expect(r.candidates[0].id).toBe(1); // the right one is untouched
  });

  it("an alias still wins: a confirmed rule beats a penalty", () => {
    const rejected = new Map([[key, new Set(["A1"])]]);
    const aliases = { client: new Map([[key, "A1"]]), global: new Map() };
    const [r] = matchLines(line, CATALOG, aliases, rejected);
    expect(r).toMatchObject({ status: "exact", via: "alias" });
    expect(r.candidates[0].id).toBe(1);
  });
});

describe("report figures", () => {
  it("accuracy is over judged rows only, and is null before anything is judged", () => {
    expect(accuracyOf(0, 0)).toBeNull();
    expect(accuracyOf(8, 2)).toBeCloseTo(0.8);
    expect(accuracyOf(0, 5)).toBe(0);
  });

  it("weekOf gives the Monday in WIB", () => {
    expect(weekOf("2026-10-16 06:43:21")).toBe("2026-10-12"); // Friday -> that Monday
    expect(weekOf("2026-10-12 00:30:00")).toBe("2026-10-12");
    // 17:30 UTC Sunday is already Monday in WIB.
    expect(weekOf("2026-10-11T17:30:00Z")).toBe("2026-10-12");
    expect(weekOf("bukan tanggal")).toBe("");
  });

  it("the note says plainly when there is too little to go on", () => {
    const base: LearningReport = { rows: 0, accepted: 0, corrected: 0, dropped: 0, newItem: 0, accuracy: null, weeks: [], topMissed: [], aliases: 0, rejectedPairs: 0 };
    expect(accuracyNote(base)).toMatch(/Belum ada baris yang dinilai/);
    expect(accuracyNote({ ...base, rows: 12, accuracy: 0.75 })).toMatch(/75%.*12 baris.*belum stabil/);
    expect(accuracyNote({ ...base, rows: 400, accuracy: 0.91 })).toBe("91% tebakan teratas dipakai apa adanya, dari 400 baris.");
  });
});
