/* Foto barang baru dari quotation (Ryoma, 2026-11-28): a sales rep adds a photo while registering a new item
   in a quote, and sees it on their request in Katalog > Barang baru menunggu Accurate.
   Fixture signature.png stands in for a product photo. */

import path from "node:path";
import { expect, test, THEMES } from "./helpers";

test.use({ storageState: "e2e/.auth/rep.json" });

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`a new item registered from a quote carries its photo (${theme})`, async ({ page, errors }) => {
      void errors;
      const name = `Stapler jumbo foto ${theme}`;
      const created = await page.request.post("/api/quotes", { data: { title: `E2E barang baru foto ${theme}` } });
      const { quote } = (await created.json()) as { quote: { id: number } };
      await page.goto(`/quotes/${quote.id}`);
      await page.getByRole("button", { name: "Dari katalog" }).first().click();
      await page.locator(".modal").getByRole("button", { name: "Barang baru", exact: true }).first().click();
      const form = page.getByRole("dialog", { name: "Barang baru" });
      await form.getByPlaceholder("Nama lengkap, mis. merek dan ukuran").fill(name);
      await form.getByLabel("Foto barang (opsional)").setInputFiles(path.resolve(import.meta.dirname, "fixtures/signature.png"));
      await page.screenshot({ path: `test-results/new-item-photo-form-${theme}.png` });
      const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/item-image\/BARU-\d+$/.test(r.url()));
      await form.getByRole("button", { name: "Buat & tambahkan" }).click();
      expect((await uploaded).status()).toBe(200);

      await page.goto("/catalog");
      const request = page.getByRole("listitem").filter({ hasText: name });
      await expect(request.getByRole("img")).toBeVisible();
      await expect(request.getByRole("button", { name: "Ganti gambar" })).toBeVisible();
      await request.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/new-item-photo-catalog-${theme}.png` });
    });
  });
}
