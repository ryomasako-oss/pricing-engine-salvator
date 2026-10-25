/* Saving twice in the editor, then submitting with an unsaved edit.

   The editor kept the version it loaded with: the second save sent a stale
   expected_version, got 409, reloaded and dropped the edit. Submit saved, then
   act() saved again with the same stale version, so an unsaved edit at submit
   time ended in a false "diubah pengguna lain" toast. */

import { expect, test } from "./helpers";

test("save, save again, then submit an unsaved edit: no conflict, every edit kept", async ({ page, errors }) => {
  void errors;
  const created = await page.request.post("/api/quotes", { data: { title: "E2E simpan dua kali" } });
  expect(created.ok()).toBe(true);
  const { quote } = (await created.json()) as { quote: { id: number } };

  await page.goto(`/quotes/${quote.id}`);
  await page.getByRole("button", { name: "Dokumen", exact: true }).click();
  const days = page.getByLabel("Term of payment (hari) *");
  const warranty = page.getByLabel("Garansi (tahun) *");
  const note = page.getByLabel("Keterangan pembayaran");
  const saveBtn = page.getByRole("button", { name: "Simpan", exact: true });
  const saveAnswers = async () => {
    const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/quotes/${quote.id}`));
    await saveBtn.click();
    return (await put).status();
  };

  await days.fill("45");
  expect(await saveAnswers()).toBe(200);

  await warranty.fill("1");
  expect(await saveAnswers(), "second save sends the version the first one produced").toBe(200);

  // Unsaved at submit time: submit saves it once, then submits.
  await note.fill("setelah invoice diterima");
  await page.getByRole("button", { name: /^Ajukan/ }).first().click();
  await page.locator(".modal").getByRole("button", { name: /^Ajukan/ }).click();
  await expect(page.locator(".hk-toast.success", { hasText: "Quotation diajukan." })).toBeVisible();
  await expect(page.locator(".hk-toast.error")).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "Dokumen", exact: true }).click();
  await expect(days).toHaveValue("45");
  await expect(warranty).toHaveValue("1");
  await expect(note).toHaveValue("setelah invoice diterima");
});
