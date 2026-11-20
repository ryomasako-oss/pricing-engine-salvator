/* Pengaturan › Kebijakan harga: who may approve a quote with a block breach
   (2026-11-20). The choice is saved with the policy and survives a reload. */

import { expect, test } from "./helpers";

test("admin switches the block-breach approver and it stays after reload", async ({ page, errors }) => {
  void errors;
  await page.goto("/settings?bagian=kebijakan");
  const rule = page.getByLabel("Yang boleh menyetujui quotation dengan pelanggaran blokir");
  await expect(rule).toHaveValue("other");
  await rule.selectOption("admin");
  await page.getByRole("button", { name: "Simpan kebijakan" }).click();
  await expect(page.locator(".hk-toast.success", { hasText: "Kebijakan harga tersimpan." })).toBeVisible();
  await page.reload();
  await expect(rule).toHaveValue("admin");
  await page.screenshot({ path: test.info().outputPath("approval-rule.png"), fullPage: true });
  // The specs share one database: put the default back.
  await rule.selectOption("other");
  await page.getByRole("button", { name: "Simpan kebijakan" }).click();
  await expect(page.locator(".hk-toast.success", { hasText: "Kebijakan harga tersimpan." })).toBeVisible();
});
