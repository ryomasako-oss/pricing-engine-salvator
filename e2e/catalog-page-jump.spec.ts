/* The catalog jumps straight to a chosen page instead of clicking
   "Berikutnya" one page at a time (50 items per page, ~7k items live). */

import { THEMES, expect, expectReadable, expectTheme, test } from "./helpers";

// Names nothing in the other specs' client lists resembles.
const ROWS = Array.from({ length: 120 }, (_, i) => ({ code: `ZQ-${String(i).padStart(3, "0")}`, name: `ZQXV ${String(i).padStart(3, "0")}` }));

test.beforeAll(async ({ request }) => {
  const r = await request.post("/api/catalog/import", { data: { rows: ROWS, source: "e2e" } });
  expect(r.ok()).toBe(true);
});

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("choosing a page number opens that page", async ({ page, errors }) => {
      void errors;
      await page.goto("/catalog");
      await expectTheme(page, theme);
      await page.getByLabel("Cari katalog").fill("ZQXV");
      const picker = page.getByLabel("Pilih halaman");
      await expect(picker).toHaveValue("0");
      await expect(picker.locator("option")).toHaveText(["1", "2", "3"]);

      await picker.selectOption({ label: "3" });
      await expect(page.getByRole("cell", { name: "ZQXV 100" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Berikutnya" })).toBeDisabled();
      await expectReadable(page.getByText(/dari 3/));
      await page.screenshot({ path: `test-results/catalog-page-jump-${theme}.png`, fullPage: true });

      await picker.selectOption({ label: "1" });
      await expect(page.getByRole("cell", { name: "ZQXV 000" })).toBeVisible();
    });
  });
}
