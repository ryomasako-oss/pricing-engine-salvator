/* "Terima N satuan" (Ryoma, 2026-11-10): a unit read from the client's wording whose ratio the catalog
   already has is accepted in one click; a unit the catalog lacks stays a per-row "Benar". */

import { THEMES, csvFile, expect, expectReadable, expectTheme, test } from "./helpers";

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("accepts catalog-known units in one click and leaves the missing ratio per row", async ({ page, errors }, info) => {
      void errors;
      const LIST = csvFile(`unit-accept-${theme}.csv`, [
        ["Nama Barang", "Qty", "Satuan"],
        ["Zqls spidol merah (isi 12/Lusin)", "2", ""], // LSN = 12 in the catalog: bulk
        ["Zqls lem batang (isi 12/Lusin)", "3", ""], // no LSN in the catalog: per row
      ]);
      await page.goto("/");
      await expectTheme(page, theme);
      await page.getByRole("button", { name: "Dari list klien" }).click();
      await page.locator('input[type="file"]').setInputFiles(LIST);

      const accept = page.getByRole("button", { name: "Terima 1 satuan" });
      await expect(accept).toBeVisible();
      await expectReadable(accept);
      await expect(page.getByRole("button", { name: /^Benar, pakai saran/ })).toHaveCount(2);
      await page.screenshot({ path: info.outputPath(`before-${theme}.png`), fullPage: true });

      await accept.click();
      await expect(accept).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Benar, pakai saran untuk Zqls spidol merah (isi 12/Lusin)" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Benar, pakai saran untuk Zqls lem batang (isi 12/Lusin)" })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`after-${theme}.png`), fullPage: true });
    });
  });
}
