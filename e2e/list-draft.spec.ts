/* Draft "Dari list klien" (2026-10-23): an admin reads a client's list,
   settles a row by hand, saves, and sends it to a sales PIC. The PIC opens it
   from the Dashboard exactly as it was left, without COGS, and finishes it
   into a quotation, which takes the draft off the list. */

import { THEMES, csvFile, expect, expectReadable, expectTheme, test } from "./helpers";

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("save, send to a PIC, reopen as the PIC and finish into a quotation", async ({ page, browser, errors }, info) => {
      void errors;
      const title = `Draft e2e ${theme}`;
      const LIST = csvFile(`draft-${theme}.csv`, [
        ["Nama Barang", "Qty", "Satuan"],
        ["Kertas HVS Sinar Dunia A4 70gr", "5", "Rim"],
        [`Tisu gulung ${theme}`, "10", "Roll"],
      ]);

      // --- admin: read, settle one row by hand, save, send ---
      await page.goto("/");
      await expectTheme(page, theme);
      await page.getByRole("button", { name: "Dari list klien" }).click();
      await page.locator('input[type="file"]').setInputFiles(LIST);
      await page.getByLabel("Judul quotation").fill(title);
      await page.getByRole("button", { name: `Cari di katalog untuk Tisu gulung ${theme}` }).click();
      await page.getByLabel("Kata kunci katalog").fill("lakban");
      await page.getByRole("button", { name: "Cari", exact: true }).click();
      await page.getByRole("button", { name: /LAKBAN BENING 48MM/ }).click();

      await page.getByRole("button", { name: "Simpan", exact: true }).click();
      await expect(page.getByText("Draft disimpan.")).toBeVisible();
      await page.getByRole("button", { name: "Kirim ke PIC…" }).click();
      await page.getByLabel("Kirim ke PIC").selectOption({ label: "Sales E2E" });
      await page.getByLabel("Catatan untuk PIC (opsional)").fill("Tolong selesaikan hari ini");
      await page.screenshot({ path: info.outputPath(`send-${theme}.png`) });
      await page.getByRole("button", { name: "Simpan & kirim" }).click();
      await expect(page.getByText("Dikirim ke Sales E2E.")).toBeVisible();

      // The admin's Dashboard lists it with its PIC.
      const adminRow = page.getByRole("row", { name: new RegExp(title) });
      await expect(adminRow).toContainText("Sales E2E");

      // --- the PIC: a rep, in their own session ---
      const ctx = await browser.newContext({ storageState: "e2e/.auth/rep.json", colorScheme: theme });
      await ctx.addInitScript((t) => localStorage.setItem("hk-theme", t), theme);
      const rep = await ctx.newPage();
      const repErrors: string[] = [];
      rep.on("console", (m) => m.type() === "error" && repErrors.push(m.text()));
      rep.on("pageerror", (e) => repErrors.push(e.message));
      await rep.goto("/");
      const row = rep.getByRole("row", { name: new RegExp(title) });
      await expect(row.getByText("Untuk Anda")).toBeVisible();
      await expectReadable(row.getByText("Untuk Anda"));
      await expect(row).toContainText("Tolong selesaikan hari ini");
      await rep.screenshot({ path: info.outputPath(`dashboard-${theme}.png`), fullPage: true });
      await row.getByRole("button", { name: "Buka" }).click();

      // Reopened as it was left: the hand-picked item is still chosen, and the rep sees prices, not COGS.
      await expect(rep.getByLabel(`Item katalog untuk Tisu gulung ${theme}`)).toHaveValue(/\d+/);
      await expect(rep.getByLabel(`Item katalog untuk Tisu gulung ${theme}`).locator("option:checked")).toContainText("LAKBAN BENING 48MM");
      await expect(rep.getByLabel("Judul quotation")).toHaveValue(title);
      await expect(rep.getByText(/Draft dari .*PIC: Sales E2E\. Catatan: Tolong selesaikan hari ini/)).toBeVisible();
      await expect(rep.getByRole("columnheader", { name: "Harga satuan" })).toBeVisible();
      await expect(rep.getByRole("columnheader", { name: "COGS" })).toHaveCount(0);
      await rep.screenshot({ path: info.outputPath(`reopened-${theme}.png`), fullPage: true });

      await rep.getByRole("button", { name: /Buat quotation \(2 item\)/ }).click();
      await expect(rep).toHaveURL(/\/quotes\/\d+$/);
      await rep.goto("/");
      await expect(rep.getByRole("row", { name: new RegExp(title) })).toHaveCount(0);
      expect(repErrors, "PIC console errors").toEqual([]);
      await ctx.close();

      // The admin's link to it is gone too: a finished draft is no longer open.
      await page.reload();
      await expect(page.getByRole("row", { name: new RegExp(title) })).toHaveCount(0);
    });
  });
}
