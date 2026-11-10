/* Jual di bawah beli: SI lines sold under the PI price of their date. Managers and admins only. */

import { expect, test } from "./helpers";

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`an SI under its PI price, with the loss (${theme})`, async ({ page, errors }) => {
      void errors;
      await page.goto("/");
      await page.getByRole("link", { name: "Jual < Beli" }).click();
      await expect(page.getByRole("heading", { name: "Jual di bawah beli" })).toBeVisible();
      await page.getByLabel("Tanggal SI dari").fill("2026-09-01");
      await page.getByLabel("Tanggal SI sampai").fill("2026-09-30");
      const row = page.getByRole("row", { name: /SI\.2026\.09\.09201/ });
      await expect(row).toContainText("ZQBC MAP PLASTIK");
      await expect(row).toContainText("Rp 9.000");
      await expect(row).toContainText("PI.2026.09.09201");
      await expect(row).toContainText("Rp 10.000"); // (10.000 - 9.000) x 10
      await page.screenshot({ path: `test-results/below-cost-${theme}.png`, fullPage: true });
    });
  });
}

test.describe("sales", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });
  test("has no Jual < Beli", async ({ page, errors }) => {
    void errors;
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Jual < Beli" })).toHaveCount(0);
  });
});
