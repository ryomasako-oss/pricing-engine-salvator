/* The colour tokens in styles.css, both themes, checked as numbers (laporan "Warna terang gelap dan
   psikologi", 9 Nov): every pair that carries meaning meets WCAG 2.2 AA, and the scenario colours stay
   apart for colour-blind eyes. Cheap, and it catches a token change before any screen does. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.resolve(import.meta.dirname, "styles.css"), "utf8");

/** Declarations of every top-level block whose selector matches, later blocks winning. */
function tokens(match: (selector: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/^([^\s{}@][^{}]*)\{([^{}]*)\}/gm)) {
    if (!match(m[1].split("\n").pop()!.trim())) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1], d[2].trim());
  }
  return out;
}
const light = tokens((s) => s === ":root, .quote-doc");
const dark = new Map([...light, ...tokens((s) => s === ':root[data-theme="dark"]')]);

type RGB = [number, number, number, number];
function color(t: Map<string, string>, name: string, depth = 0): RGB {
  const v = t.get(name);
  if (!v) throw new Error(`token ${name} not found`);
  const ref = /^var\((--[\w-]+)/.exec(v);
  if (ref && depth < 5) return color(t, ref[1], depth + 1);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255).concat(1) as RGB;
  const rgba = /^rgba?\(([^)]+)\)/.exec(v);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [r / 255, g / 255, b / 255, a];
  }
  throw new Error(`token ${name} = ${v} is not a colour`);
}
const over = (fg: RGB, bg: RGB): RGB => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as RGB;
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
function contrast(t: Map<string, string>, fg: string, bg: string, under = "--color-layer"): number {
  const base = color(t, under);
  const b = over(color(t, bg), base);
  const f = over(color(t, fg), b);
  const [hi, lo] = [lum(f), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = { terang: light, gelap: dark } as const;
const SURFACES = ["--color-bg", "--color-layer", "--color-layer-2", "--color-hover"];

describe.each(Object.entries(THEMES))("tema %s", (_name, t) => {
  it("text reads at 4.5:1 on every surface", () => {
    for (const fg of ["--color-text", "--color-text-2", "--color-placeholder", "--color-err-text"]) {
      for (const bg of SURFACES) expect(contrast(t, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // Action text sits on surfaces; on the hover grey it turns --color-action-hover (.btn.ghost:hover).
    for (const bg of ["--color-bg", "--color-layer", "--color-layer-2"]) {
      expect(contrast(t, "--color-action", bg), `--color-action on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t, "--color-action-hover", "--color-hover"), "--color-action-hover on --color-hover").toBeGreaterThanOrEqual(4.5);
  });

  it("status badges read at 4.5:1 on their own tint", () => {
    const pairs = [
      ["--color-ok-text", "--color-ok-bg"],
      ["--color-warn-text", "--color-warn-bg"],
      ["--color-err-text", "--color-err-bg"],
      ["--color-info", "--color-info-bg"],
      ["--color-neutral-text", "--color-neutral-bg"],
      ["--color-purple-text", "--color-purple-bg"],
    ];
    for (const [fg, bg] of pairs) expect(contrast(t, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("scenario colours read as small text everywhere they sit, their own tint included", () => {
    for (const k of [1, 2, 3]) {
      for (const bg of [...SURFACES, `--s${k}-bg`]) expect(contrast(t, `--s${k}`, bg), `--s${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("controls and marks reach 3:1 (WCAG 1.4.11)", () => {
    for (const bg of ["--color-layer", "--color-layer-2"]) {
      expect(contrast(t, "--color-border-strong", bg), `input edge on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t, "--color-focus", bg), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t, "--color-warn-mark", bg), `warning mark on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

it("the quotation sheet's red reads on white", () => {
  const white = new Map([["--w", "#FFFFFF"], ["--doc-err", light.get("--doc-err")!], ["--color-layer", "#FFFFFF"]]);
  expect(contrast(white, "--doc-err", "--w")).toBeGreaterThanOrEqual(4.5);
});

/* Machado et al. 2009, severity 1, and OKLab distance x100: S1, S2 and S3 must not merge. */
const CVD = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
function oklab(c: RGB, m: number[][]): number[] {
  const v = [lin(c[0]), lin(c[1]), lin(c[2])];
  const [r, g, b] = m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const l = Math.cbrt(Math.max(0, 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b));
  const mm = Math.cbrt(Math.max(0, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b));
  const s = Math.cbrt(Math.max(0, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b));
  return [0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s];
}
it.each(Object.entries(THEMES))("tema %s: scenario colours stay apart for colour-blind eyes", (_n, t) => {
  for (const [a, b] of [[1, 2], [1, 3], [2, 3]]) {
    for (const [kind, m] of Object.entries(CVD)) {
      const d = 100 * Math.hypot(...oklab(color(t, `--s${a}`), m).map((x, i) => x - oklab(color(t, `--s${b}`), m)[i]));
      expect(d, `S${a} vs S${b} (${kind})`).toBeGreaterThanOrEqual(8);
    }
  }
});
