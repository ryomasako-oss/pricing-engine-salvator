/* Tombol stok Accurate di Katalog dan Gudang (pemilik, 2026-11-25): arah tertulis di namanya. Tarik dari Accurate,
   Cocokkan (tidak memindahkan data), Kirim ke Accurate (mati, selisih diinput manual). */

import { expect, test } from "./helpers";

for (const path of ["/catalog", "/gudang"]) {
  test(`${path}: Tarik dari Accurate, Cocokkan, Kirim ke Accurate (off)`, async ({ page, errors }) => {
    void errors;
    await page.goto(path);
    const tarik = page.getByRole("button", { name: /Ambil stok terbaru dari Accurate/ });
    await expect(tarik).toHaveText("Tarik dari Accurate");
    const cocok = page.getByRole("button", { name: /tidak memindahkan data/ });
    await expect(cocok).toHaveText("Cocokkan");
    const kirim = page.getByRole("button", { name: /Kirim selisih hitungan/ });
    await expect(kirim).toHaveText("Kirim ke Accurate");
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", /Belum aktif/);
    await cocok.click();
    await expect(page.getByRole("dialog", { name: /Selisih stok dengan Accurate/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`stock-buttons${path.replace("/", "-")}.png`) });
  });
}
