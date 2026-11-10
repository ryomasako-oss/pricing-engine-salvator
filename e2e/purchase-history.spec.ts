/* Riwayat pembelian (PI): each item's purchase invoices, the price on the PI ("termasuk PPN")
   and the modal before PPN. Managers and admins only; the menu has it beside Riwayat SI. */

import { expect, test } from "./helpers";

test.use({ theme: "light" });

test("an item's PIs, invoice price and modal apart", async ({ page, errors }) => {
  void errors;
  await page.goto("/");
  await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Riwayat", exact: true }).click();
  await page.getByRole("navigation", { name: "Jenis riwayat" }).getByRole("link", { name: "Pembelian (PI)" }).click();
  await expect(page.getByRole("heading", { name: "Riwayat pembelian (PI)" })).toBeVisible();
  await page.getByLabel("Cari riwayat pembelian").fill("zqsi");
  const card = page.getByRole("region", { name: "ZQSI PELUMAS RANTAI" });
  const newest = card.getByRole("row", { name: /PI\.2026\.10\.09101/ });
  await expect(newest).toContainText("termasuk PPN");
  await expect(newest).toContainText("Rp 9.990");
  await expect(newest).toContainText("Rp 9.000");
  await expect(card.getByRole("row", { name: /PI\.2026\.08\.09102/ })).not.toContainText("termasuk PPN");
});

test.describe("sales", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });
  test("has no Riwayat", async ({ page, errors }) => {
    void errors;
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Riwayat", exact: true })).toHaveCount(0);
  });
});
