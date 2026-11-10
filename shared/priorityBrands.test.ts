import { describe, expect, it } from "vitest";
import { splitBrandQuery } from "./priorityBrands";

describe("splitBrandQuery: priority brands in any spelling (Ryoma, 2026-11-09)", () => {
  it.each([
    ["vtec", ["V-TEC", "VTEC"], ""], ["V-TEC", ["V-TEC", "VTEC"], ""], ["v tec", ["V-TEC", "VTEC"], ""], ["v.tec", ["V-TEC", "VTEC"], ""],
    ["vtech", ["V-TEC", "VTEC"], ""], ["vitek", ["V-TEC", "VTEC"], ""], ["vetec", ["V-TEC", "VTEC"], ""], ["kuas vtec", ["V-TEC", "VTEC"], "kuas"],
    ["vtec push pin", ["V-TEC", "VTEC"], "push pin"],
    ["artline", ["ARTLINE"], ""], ["artlin", ["ARTLINE"], ""], ["art line", ["ARTLINE"], ""], ["Art-Line spidol", ["ARTLINE"], "spidol"],
    ["gm alvaboard", ["GM"], "alvaboard"], ["G.M label", ["GM"], "label"],
  ])("%s", (q, catalog, rest) => {
    expect(splitBrandQuery(q)).toEqual({ catalog, rest });
  });

  it.each(["blu tack 75 gm", "lem 35gm", "logitech", "powertec", "detector", "kertas a4", "smartline"])("leaves %s as typed", (q) => {
    expect(splitBrandQuery(q)).toEqual({ catalog: null, rest: q });
  });
});
