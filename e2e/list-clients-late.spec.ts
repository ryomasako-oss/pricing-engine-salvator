/* "Dari list klien" opened before the client list has loaded still gets the clients when they
   arrive (10 Nov: the dialog copied the list once and stayed "Tanpa klien" for good). */

import { expect, test } from "./helpers";

test.use({ theme: "light" });

test("clients that arrive after the dialog opened show up in its Klien choice", async ({ page, errors }) => {
  void errors;
  await page.route("**/api/clients", async (r) => {
    await new Promise((ok) => setTimeout(ok, 1500));
    await r.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Dari list klien" }).click();
  const klien = page.getByRole("combobox", { name: "Klien", exact: true });
  await expect(klien.locator("option", { hasText: "PT Agrinesia" })).toHaveCount(1);
});
