/* The first Tab stop skips the top-bar menu: Enter moves focus to the page's main
   content, so the next Tab lands on the page's own first control. */

import { expect, test } from "./helpers";
test.use({ theme: "light" });
test("skip link", async ({ page }) => {
  await page.goto("/catalog");
  await page.getByRole("heading", { name: "Katalog barang" }).waitFor();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Lewati ke isi halaman" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Impor" })).toBeFocused();
});
