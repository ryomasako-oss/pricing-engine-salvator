/* Stock shows how old it is: "stok Accurate per …" on the catalog and in the
   quote's catalog picker, from the last completed Accurate run. */

import { THEMES, expect, expectReadable, expectTheme, test } from "./helpers";

// 2026-10-30T01:00Z, as id-ID renders it in the browser's time zone.
const AS_OF = /stok Accurate per \d{2} Okt 2026,? \d{2}[.:]\d{2}/i;

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("catalog and catalog picker say when the stock was read from Accurate", async ({ page, errors }) => {
      void errors;
      await page.goto("/catalog");
      await expectTheme(page, theme);
      const note = page.getByText(AS_OF);
      await expect(note).toBeVisible();
      await expectReadable(note);
      await page.screenshot({ path: `test-results/stock-as-of-catalog-${theme}.png`, fullPage: true });

      const created = await page.request.post("/api/quotes", { data: { title: `E2E stok ${theme}` } });
      const { quote } = (await created.json()) as { quote: { id: number } };
      await page.goto(`/quotes/${quote.id}`);
      await page.getByRole("button", { name: "Dari katalog" }).first().click();
      await expect(page.locator(".modal").getByText(AS_OF)).toBeVisible();
      await page.screenshot({ path: `test-results/stock-as-of-picker-${theme}.png` });
    });
  });
}
