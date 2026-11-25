/* Satu tombol Accurate (2026-11-25) di Katalog dan Gudang: "Sinkron Accurate" dengan penjelasan saat kursor diarahkan;
   tombol Tarik/Cocokkan/Kirim terpisah sudah tidak ada. */

import { expect, test } from "./helpers";

for (const path of ["/catalog", "/gudang"]) {
  test(`${path}: one Sinkron Accurate button with a hint`, async ({ page, errors }) => {
    void errors;
    await page.goto(path);
    const sync = page.getByRole("button", { name: /Ambil stok terbaru dari Accurate/ });
    await expect(sync).toBeVisible();
    await expect(sync).toHaveText("Sinkron Accurate");
    await expect(page.getByRole("button", { name: /^Tarik$|^Cocokkan$|^Kirim/ })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`stock-buttons${path.replace("/", "-")}.png`) });
  });
}
