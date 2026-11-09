/* Pengaturan › Notifikasi: the WhatsApp and Telegram numbers are saved on their own
   forms (PATCH /auth/profile), and saving one keeps the other. */

import { expect, test } from "./helpers";

test.use({ theme: "light", storageState: "e2e/.auth/rep.json" });

test("WhatsApp and Telegram numbers save separately", async ({ page }) => {
  await page.goto("/settings?bagian=notifikasi");
  const wa = page.getByLabel("Nomor WhatsApp saya");
  const tg = page.getByLabel("Nomor Telegram saya");
  await wa.fill("0812 3456 789");
  await page.getByRole("button", { name: "Simpan nomor" }).first().click();
  await expect(page.locator(".hk-toast.success", { hasText: "Nomor WhatsApp disimpan." })).toBeVisible();
  await tg.fill("0857 1111 2222");
  await page.getByRole("button", { name: "Simpan nomor" }).nth(1).click();
  await expect(page.locator(".hk-toast.success", { hasText: "Nomor Telegram disimpan." })).toBeVisible();
  await page.reload();
  await expect(wa).toHaveValue("0812 3456 789");
  await expect(tg).toHaveValue("0857 1111 2222");
});
