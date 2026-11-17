/* Stock UOM Adjustment: one row per item and unit pair whose SI unit differs from the PI's, no-ratio ones
   first; same unit in another case ("pcs" vs "Pcs") is not listed. Managers and admins only. */

import { expect, test } from "./helpers";

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`lists item and unit pairs whose SI unit differs from the PI (${theme})`, async ({ page, errors }) => {
      void errors;
      await page.goto("/");
      await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Riwayat", exact: true }).click();
      await page.getByRole("navigation", { name: "Jenis riwayat" }).getByRole("link", { name: "Stock UOM Adjustment" }).click();
      await expect(page.getByRole("heading", { name: "Stock UOM Adjustment" })).toBeVisible();
      await page.getByLabel("Tanggal SI dari").fill("2026-07-01");
      await page.getByLabel("Tanggal SI sampai").fill("2026-07-31");

      const rows = page.getByRole("row", { name: /ZQUD AMPLOP COKLAT/ });
      await expect(rows).toHaveCount(2); // BOX vs Pcs and DUS vs Pcs; the "pcs" SI is the same unit
      await expect(rows.nth(0)).toContainText("DUS"); // no ratio: first
      await expect(rows.nth(0)).toContainText("Rasio belum diisi");
      await expect(rows.nth(1)).toContainText("1 BOX = 12 Pcs");
      await expect(rows.nth(1)).toContainText("1 di bawah harga beli");

      await page.getByRole("button", { name: "Lihat SI ZQUD-1 BOX" }).click();
      await expect(page.getByRole("table", { name: "SI ZQUD-1" })).toContainText("SI.2026.07.09301");
      await expect(page.getByRole("table", { name: "SI ZQUD-1" })).toContainText("PT Zqud Klien");

      await page.getByRole("button", { name: /Barang dengan rasio ada/ }).click();
      await expect(rows).toHaveCount(1);
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

test("Sesuaikan once sets the ratio for every SI of the item and puts SI and PI head to head", async ({ page, errors }) => {
  void errors;
  await page.goto("/stock-uom-adjustment");
  await page.getByLabel("Tanggal SI dari").fill("2026-06-01");
  await page.getByLabel("Tanggal SI sampai").fill("2026-06-30");
  const row = page.getByRole("row", { name: /ZQUA KANTONG PLASTIK/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("2 SI");
  await expect(row).toContainText("Rasio belum diisi");

  await page.getByRole("button", { name: "Sesuaikan ZQUA-1 PAK" }).click();
  await page.getByLabel("Isi 1 PAK dalam Pcs").fill("10");
  await page.getByLabel("Catatan penyesuaian").fill("cek fisik gudang");
  await page.getByRole("button", { name: "Simpan" }).click();

  // Newest SI: 3 PAK of 10 Pcs for 45.000 = 1.500 per Pcs, against 1.000 per Pcs on the PI.
  await expect(row).toContainText("Disesuaikan: 1 PAK = 10 Pcs");
  await expect(row).toContainText("Rasio ada");
  await expect(row).toContainText("Rp 1.500");
  await expect(row).toContainText("Rp 1.000");
  await page.getByRole("button", { name: "Lihat SI ZQUA-1 PAK" }).click();
  // Both SIs took the one ratio: the older one, 2 PAK for 10.000, is 500 per Pcs, under cost.
  const detail = page.getByRole("table", { name: "SI ZQUA-1" });
  await expect(detail).toContainText("Rp 1.500");
  await expect(detail).toContainText("Rp 500");
  await page.screenshot({ path: "test-results/uom-adjust.png", fullPage: true });
});
