/* "Terima N saran" (Ryoma, 2026-11-09): rows that are "Perlu dicek" only because colour variants tie can be
   accepted in one click; a row missing a word the client wrote cannot; bulk rows are never saved as aliases. */

import { THEMES, csvFile, expect, expectReadable, expectTheme, test } from "./helpers";

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("accepts the tied rows in one click and keeps them out of the client's aliases", async ({ page, errors }, info) => {
      void errors;
      // Per theme: the light run saves this wording as a client alias, which would settle it for the dark run.
      const paper = `Kertas HVS Paperone A4 70gr ${theme}`;
      const LIST = csvFile(`accept-all-${theme}.csv`, [
        ["Nama Barang", "Qty", "Satuan"],
        ["Zqhl highlighter", "3", "Pcs"], // ties BLUE / GREEN: bulk
        ["Kertas HVS Sinar Dunia A4 70gr", "5", "Rim"], // Cocok
        [paper, "5", "Rim"], // "paperone" is in no item: review, never bulk
      ]);
      await page.goto("/");
      await expectTheme(page, theme);
      await page.getByRole("button", { name: "Dari list klien" }).click();
      await page.getByRole("combobox", { name: "Klien", exact: true }).selectOption({ label: "PT Agrinesia" });
      await page.locator('input[type="file"]').setInputFiles(LIST);

      const review = page.locator(".badge", { hasText: /^\d+ perlu dicek$/ });
      await expect(review).toHaveText("2 perlu dicek");
      const accept = page.getByRole("button", { name: "Terima 1 saran" });
      await expect(accept).toBeVisible();
      await expectReadable(accept);
      await page.screenshot({ path: info.outputPath(`before-${theme}.png`), fullPage: true });
      await accept.click();
      await expect(accept).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Item katalog untuk Zqhl highlighter" })).toHaveValue(/ZQHL HIGHLIGHTER/);
      await page.screenshot({ path: info.outputPath(`after-${theme}.png`), fullPage: true });

      // The other review row still asks; settle it by hand, pick a client, create.
      await page.getByRole("combobox", { name: `Item katalog untuk ${paper}` }).click();
      await page.getByRole("option", { name: /^KERTAS HVS SINAR DUNIA A4 70GR/ }).first().click();
      await page.getByLabel("Judul quotation").fill(`Terima semua ${theme}`);
      const saved = page.waitForRequest((r) => r.url().endsWith("/api/catalog/aliases") && r.method() === "POST");
      await page.getByRole("button", { name: /Buat quotation/ }).click();
      const body = (await saved).postDataJSON() as { pairs: { text: string }[]; feedback: { text: string }[] };
      expect(body.pairs.map((p) => p.text)).toEqual([paper]);
      expect(body.feedback.map((f) => f.text)).not.toContain("Zqhl highlighter");
      await expect(page).toHaveURL(/\/quotes\/\d+$/);
    });
  });
}
