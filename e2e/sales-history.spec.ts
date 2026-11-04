/* Riwayat penjualan (SI): typing a client's wording finds the item it was invoiced as,
   with its invoices and wordings (seeded in e2e/serve.ts). Sales may not open it. */

import { THEMES, expect, expectReadable, expectTheme, test } from "./helpers";

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("a client's wording finds the item it was invoiced as", async ({ page, errors }) => {
      void errors;
      // Both histories sit in the top menu (a lighter page than /quotes: the suite runs near the API rate limit).
      await page.goto("/sales-history");
      const nav = page.getByRole("navigation", { name: "Navigasi utama" });
      await expect(nav.getByRole("link", { name: "Riwayat COGS" })).toHaveAttribute("href", "/cogs-history");
      await expect(nav.getByRole("link", { name: "Riwayat SI" })).toHaveAttribute("aria-current", "page");
      await expectTheme(page, theme);
      await page.getByLabel("Cari riwayat penjualan").fill("oli rantai");
      await expect(page.getByText("ZQSI PELUMAS RANTAI", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/SI\.2026\.10\.09001 · PT Zqsi Klien · 2 BOX · Rp\s?144\.000 \/ BOX \(Rp\s?12\.000 \/ Btl\)/)).toBeVisible();
      await expect(page.getByText("zqsi oli rantai 800ml").first()).toBeVisible();
      await expectReadable(page.getByText(/SI\.2026\.09\.09002/));
      await page.screenshot({ path: `test-results/sales-history-${theme}.png`, fullPage: true });

      await page.getByLabel("Cari riwayat penjualan").fill("tidak ada yang begini");
      await expect(page.getByText("Tidak ada penjualan yang cocok")).toBeVisible();
    });
  });
}

test.describe("sales", () => {
  test.use({ storageState: "e2e/.auth/rep.json", expectedConsole: [/sales-history/, /403/] });

  test("cannot open it", async ({ page, request }) => {
    expect((await request.get("/api/accurate/sales-history")).status()).toBe(403);
    await page.goto("/pencocokan");
    await expect(page.getByRole("heading", { name: "Pencocokan barang" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Riwayat penjualan (SI)" })).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Navigasi utama" });
    await expect(nav.getByRole("link", { name: /Riwayat/ })).toHaveCount(0);
  });
});
