import { describe, expect, it } from "vitest";
import { positional } from "./sqlParams";

describe("positional", () => {
  it("rewrites ?N to ? and orders the values to match, repeats included", () => {
    expect(positional("SELECT ?2 AS b, ?1 AS a WHERE x = ?1", ["a", "b"])).toEqual({
      sql: "SELECT ? AS b, ? AS a WHERE x = ?",
      params: ["b", "a", "a"],
    });
  });
  it("leaves plain ? and mixed statements alone", () => {
    expect(positional("SELECT ?, ?", [1, 2])).toEqual({ sql: "SELECT ?, ?", params: [1, 2] });
    expect(positional("SELECT ?1, ?", [1, 2])).toEqual({ sql: "SELECT ?1, ?", params: [1, 2] });
  });
});
