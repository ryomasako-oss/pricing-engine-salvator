/* Tarik / Cocokkan / Kirim on Katalog and Gudang (2026-11-20): short labels, a hint on hover (title and
   aria-label), Kirim shown but off, Cocokkan opens the comparison. */

import { expect, test } from "./helpers";

for (const path of ["/catalog", "/gudang"]) {
  test(`${path}: three stock buttons with hints, Kirim is off`, async ({ page, errors }) => {
    void errors;
    await page.goto(path);
    const tarik = page.getByRole("button", { name: "Ambil data stok terbaru dari Accurate ke Pricing Engine" });
    await expect(tarik).toBeVisible();
    await expect(tarik).toHaveText("Tarik");
    await expect(tarik).toHaveAttribute("title", "Ambil data stok terbaru dari Accurate ke Pricing Engine");
    const cocok = page.getByRole("button", { name: "Bandingkan angka stok di Pricing Engine dengan Accurate" });
    await expect(cocok).toHaveAttribute("title", "Bandingkan angka stok di Pricing Engine dengan Accurate");
    const kirim = page.getByRole("button", { name: /Kirim perubahan stok yang sudah di-ACC ke Accurate/ });
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Belum aktif: menunggu izin token Accurate dan data akuntansi");
    await cocok.click();
    await expect(page.getByRole("dialog", { name: /Cocokkan stok/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`stock-buttons${path.replace("/", "-")}.png`) });
  });
}
