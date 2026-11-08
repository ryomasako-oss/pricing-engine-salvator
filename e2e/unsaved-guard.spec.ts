/* Unsaved quote edits are asked about before any in-app navigation: top-bar links,
   the page's own back link, and the browser's Back button (router blocker in
   src/context/UnsavedGuardContext.tsx). Batal keeps the edits on the page. */

import { expect, test } from "./helpers";
test.use({ theme: "light" });
test("guard: in-app back, nav link, back link", async ({ page }) => {
  const { quote } = await (await page.request.post("/api/quotes", { data: { title: "Guard" } })).json();
  await page.goto("/quotes");
  await page.getByRole("link", { name: quote.number }).click();
  await page.getByRole("button", { name: "Dokumen", exact: true }).click();
  await page.getByLabel("Catatan tambahan di penawaran").fill("ubah");
  await expect(page.getByText("Belum disimpan")).toBeVisible();
  await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Klien" }).click();
  await expect(page.getByRole("heading", { name: "Tinggalkan halaman?" })).toBeVisible();
  await page.locator(".modal").getByRole("button", { name: "Batal" }).click();
  await expect(page).toHaveURL(new RegExp("/quotes/" + quote.id));
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Tinggalkan halaman?" })).toBeVisible();
  await page.locator(".modal").getByRole("button", { name: "Batal" }).click();
  await expect(page).toHaveURL(new RegExp("/quotes/" + quote.id));
  await expect(page.getByLabel("Catatan tambahan di penawaran")).toHaveValue("ubah");
  await page.getByRole("button", { name: "Semua quotation" }).click();
  await page.locator(".modal").getByRole("button", { name: "Tinggalkan" }).click();
  await expect(page).toHaveURL(/\/quotes$/);
});
test.describe("rep", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });
  test("guard on the sales page", async ({ page }) => {
    const { quote } = await (await page.request.post("/api/quotes", { data: { title: "Guard rep" } })).json();
    await page.goto("/quotes");
    await page.getByRole("link", { name: quote.number }).click();
    await page.getByLabel("Catatan tambahan di penawaran").fill("ubah");
    await expect(page.getByText("Belum disimpan")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Tinggalkan halaman?" })).toBeVisible();
    await page.locator(".modal").getByRole("button", { name: "Tinggalkan" }).click();
    await expect(page).toHaveURL(/\/quotes$/);
  });
});
