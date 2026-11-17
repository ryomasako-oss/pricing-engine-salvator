/* Stock UOM Adjustment: SI lines in another unit than their PI, no-ratio ones first; same unit in another
   case ("pcs" vs "Pcs") is not listed. Managers and admins only. */

import { expect, test } from "./helpers";

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`lists SI lines whose unit differs from the PI (${theme})`, async ({ page, errors }) => {
      void errors;
      await page.goto("/");
      await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Riwayat", exact: true }).click();
      await page.getByRole("navigation", { name: "Jenis riwayat" }).getByRole("link", { name: "Stock UOM Adjustment" }).click();
      await expect(page.getByRole("heading", { name: "Stock UOM Adjustment" })).toBeVisible();
      await page.getByLabel("Tanggal SI dari").fill("2026-07-01");
      await page.getByLabel("Tanggal SI sampai").fill("2026-07-31");

      const rows = page.getByRole("row", { name: /SI\.2026\.07\.093/ });
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText("SI.2026.07.09302"); // DUS, no ratio: first
      await expect(rows.nth(0)).toContainText("Rasio belum diisi");
      await expect(rows.nth(1)).toContainText("1 BOX = 12 Pcs");
      await expect(rows.nth(1)).toContainText("PI.2026.07.09301");
      await expect(page.getByRole("row", { name: /SI\.2026\.07\.09303/ })).toHaveCount(0);

      await page.getByRole("button", { name: /Satuan beda, rasio ada/ }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("SI.2026.07.09301");
      await page.screenshot({ path: `test-results/uom-diff-${theme}.png`, fullPage: true });

      // The same difference is marked on Jual < Beli (the BOX line sold at 750 per Pcs, bought at 1.000).
      await page.getByRole("navigation", { name: "Jenis riwayat" }).getByRole("link", { name: "Jual < Beli" }).click();
      await expect(page.getByRole("heading", { name: "Jual di bawah beli" })).toBeVisible();
      await page.getByLabel("Tanggal SI dari").fill("2026-07-01");
      await page.getByLabel("Tanggal SI sampai").fill("2026-07-31");
      await expect(page.getByRole("row", { name: /SI\.2026\.07\.09301/ })).toContainText("Satuan SI BOX ≠ PI Pcs");
    });
  });
}

test.use({ theme: "light" });

test("Sesuaikan sets the missing ratio and puts SI and PI head to head", async ({ page, errors }) => {
  void errors;
  await page.goto("/stock-uom-adjustment");
  await page.getByLabel("Tanggal SI dari").fill("2026-06-01");
  await page.getByLabel("Tanggal SI sampai").fill("2026-06-30");
  const row = page.getByRole("row", { name: /SI\.2026\.06\.09401/ });
  await expect(row).toContainText("Rasio belum diisi");

  await page.getByRole("button", { name: "Sesuaikan SI.2026.06.09401 ZQUA-1" }).click();
  await page.getByLabel("Isi 1 PAK dalam Pcs").fill("10");
  await page.getByLabel("Catatan penyesuaian").fill("cek fisik gudang");
  await page.getByRole("button", { name: "Simpan" }).click();

  // 3 PAK of 10 Pcs for 45.000 = 1.500 per Pcs, against 1.000 per Pcs on the PI.
  await expect(row).toContainText("Disesuaikan: 1 PAK = 10 Pcs");
  await expect(row).toContainText("Rasio ada");
  await expect(row).toContainText("Rp 1.500");
  await expect(row).toContainText("Rp 1.000");
  await page.screenshot({ path: "test-results/uom-adjust.png", fullPage: true });
});
