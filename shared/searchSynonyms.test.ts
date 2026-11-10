import { describe, expect, it } from "vitest";
import { searchWords } from "./searchSynonyms";

describe("searchWords (Ryoma, 2026-11-09)", () => {
  it("adds each word's synonyms, short ones as whole words", () => {
    expect(searchWords("spidol permanen")).toEqual([
      { typed: "spidol", synonyms: [{ word: "MARKER", whole: false }] },
      { typed: "permanen", synonyms: [{ word: "PERMANENT", whole: false }] },
    ]);
    expect(searchWords("pulpen").at(0)!.synonyms).toContainEqual({ word: "PEN", whole: true });
  });
  it("keeps words with no synonym as typed and drops punctuation-only ones", () => {
    expect(searchWords("kertas a4 - 70gr")).toEqual([
      { typed: "kertas", synonyms: [{ word: "PAPER", whole: false }] },
      { typed: "a4", synonyms: [] },
      { typed: "70gr", synonyms: [] },
    ]);
  });
});
