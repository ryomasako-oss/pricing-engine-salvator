/* A page whose data fails to load says so and offers one retry (components/LoadError.tsx),
   instead of an empty page with only a toast. */

import { expect, test } from "./helpers";
test.use({ theme: "light" });
test("load error and retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/clients", (r) => fail ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Server sedang sibuk."}' }) : r.continue());
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Gagal memuat data" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByRole("heading", { name: "Gagal memuat data" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Cari nama, kode, atau PIC")).toBeVisible();
});
