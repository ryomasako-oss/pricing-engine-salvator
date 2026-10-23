import { expect, test as base, type Locator, type Page } from "@playwright/test";

export type Theme = "light" | "dark";
export const THEMES: Theme[] = ["light", "dark"];

/**
 * Every page fails its test on a console error or an uncaught exception, and
 * opens in the theme it asks for. The theme is stored where the app reads it
 * (src/context/ThemeContext.tsx, "hk-theme"), because a stored choice wins
 * over the OS setting and two "themed" runs could otherwise both be light.
 */
export const test = base.extend<{ theme: Theme; errors: string[]; expectedConsole: RegExp[] }>({
  theme: ["light", { option: true }],
  /** Console errors a test causes on purpose (the browser logs every 4xx response), by text or resource URL. */
  expectedConsole: [[], { option: true }],
  errors: async ({ page, expectedConsole }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const where = m.location().url;
      if (expectedConsole.some((re) => re.test(m.text()) || re.test(where))) return;
      errors.push(`${m.text()} (${where})`);
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await use(errors);
    expect(errors, "console errors").toEqual([]);
  },
  page: async ({ page, theme }, use) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem("hk-theme", t), theme);
    await use(page);
  },
});
export { expect };

export async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/**
 * WCAG contrast ratio between an element's text and the first opaque
 * background behind it, from computed styles.
 */
export async function contrastOf(el: Locator): Promise<number> {
  // Colours are read once transitions have finished: mid-transition (the theme
  // switching on load) the same element read 4.1, 6.1 and 7.9 within a second.
  await el.page().waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  return el.evaluate((node) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const fg = parse(getComputedStyle(node).color)!;
    // Translucent backgrounds (dark-theme badges are rgba(…, 0.16)) are laid over
    // whatever is behind them, down to the first opaque one.
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 0.99) break;
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of layers.reverse()) {
      bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a), a: 1 };
    }
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
}

/** Text that must read clearly: WCAG AA for normal text. */
export async function expectReadable(el: Locator, min = 4.5) {
  const ratio = await contrastOf(el);
  expect(ratio, `contrast of "${(await el.innerText()).slice(0, 40)}"`).toBeGreaterThanOrEqual(min);
}

/** A client's request list as a CSV file the upload accepts (src/import/parsers.ts parseRequestList). */
export function csvFile(name: string, rows: string[][]) {
  return {
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")),
  };
}
