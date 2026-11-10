/* Cancelling a saved list draft asks first (it throws away the review), with a labelled button
   beside "Buka", not a loose ×. */

import { expect, test } from "./helpers";

test.use({ theme: "light" });

test("Batalkan asks, names the draft, and only then cancels it", async ({ page, errors }) => {
  void errors;
  const title = `Draft batal ${Date.now()}`;
  const made = await page.request.post("/api/list-drafts", {
    data: { title, lines: [{ name: "pulpen hitam", qty: 1 }], choices: [{ chosen: null, confirmed: false, extra: [] }] },
  });
  expect(made.ok()).toBe(true);
  await page.goto("/");
  const row = page.getByRole("row", { name: new RegExp(title) });
  await row.getByRole("button", { name: `Batalkan draft ${title}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(title);
  await dialog.getByRole("button", { name: "Batal", exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: `Batalkan draft ${title}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Batalkan draft" }).click();
  await expect(page.getByRole("row", { name: new RegExp(title) })).toHaveCount(0);
});
