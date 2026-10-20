/* The header of List → Quotation counts what the rows say now.

   It used to count the matcher's first verdict (result.status), which never
   changes, so "2 adjustment" stayed "2 adjustment" while the rep settled both
   rows. */

import { THEMES, csvFile, expect, expectReadable, expectTheme, test } from "./helpers";

const LIST = csvFile("list-klien.csv", [
  ["Nama Barang", "Qty", "Satuan"],
  ["Kertas HVS Sinar Dunia A4 70gr", "5", "Rim"],
  ["Spidol whiteboard snowman hitam", "12", "Pcs"],
  ["Tisu gulung nice", "10", "Roll"],
  ["Teh kotak 300ml", "24", "Pcs"],
]);

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("settling an adjustment row takes it off the header count at once", async ({ page, errors }) => {
      void errors;
      await page.goto("/");
      await expectTheme(page, theme);
      await page.getByRole("button", { name: "Dari list klien" }).click();
      await page.locator('input[type="file"]').setInputFiles(LIST);

      // The header badges ("2 adjustment"), not the rows' own "Adjustment" status.
      const header = (word: string) => page.locator(".badge", { hasText: new RegExp(`^\\d+ ${word}$`) });
      const adjustment = header("adjustment");
      await expect(adjustment).toHaveText("2 adjustment");
      await expect(header("cocok")).toHaveText("2 cocok");
      await expectReadable(adjustment);

      // Row 3: picked from the inline catalog search.
      await page.getByRole("button", { name: "Cari di katalog untuk Tisu gulung nice" }).click();
      await page.getByLabel("Kata kunci katalog").fill("lakban");
      await page.getByRole("button", { name: "Cari", exact: true }).click();
      await page.getByRole("button", { name: /LAKBAN BENING 48MM/ }).click();
      await expect(adjustment).toHaveText("1 adjustment");
      await expect(header("cocok")).toHaveText("3 cocok");

      // Row 4: made a barang baru. It is held, so it moves to "ditahan", not to "cocok".
      await page.getByRole("button", { name: "Buat barang baru untuk Teh kotak 300ml" }).click();
      await page.getByRole("button", { name: "Buat & tambahkan" }).click();
      await expect(adjustment).toHaveCount(0);
      await expect(header("ditahan")).toHaveText("1 ditahan");
      await expect(header("cocok")).toHaveText("3 cocok");
      await expectReadable(header("ditahan"));
    });
  });
}
