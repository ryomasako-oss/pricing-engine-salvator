/* "Jelaskan" in Jual < Beli (Ryoma, 2026-11-28): the team's explanation of an SI line becomes a task in
   Perlu diperbaiki, and the row shows it, open then done. */

import { expect, test } from "./helpers";

test.describe.configure({ mode: "serial" });

async function open(page: import("@playwright/test").Page) {
  await page.goto("/below-cost");
  await page.getByLabel("Tanggal SI dari").fill("2026-09-01");
  await page.getByLabel("Tanggal SI sampai").fill("2026-09-30");
  return page.getByRole("row", { name: /SI\.2026\.09\.09202/ });
}

test.describe("light", () => {
  test.use({ theme: "light" });
  test("explain a row, follow it up in Perlu diperbaiki, close it", async ({ page, errors }) => {
    void errors;
    const row = await open(page);
    await row.getByRole("button", { name: "Jelaskan SI.2026.09.09202 ZQBC-1" }).click();
    const dialog = page.getByRole("dialog", { name: "Jelaskan SI.2026.09.09202" });
    await expect(dialog).toContainText("rugi Rp 10.000");
    await dialog.getByLabel("Apa yang sebenarnya terjadi?").fill("Harga lama ke CV Zqbc Lain belum dinaikkan sesudah PI September.");
    await page.screenshot({ path: "test-results/below-cost-explain-modal-light.png" });
    await dialog.getByRole("button", { name: "Simpan & jadikan tugas" }).click();
    await expect(row).toContainText("Task terbuka");
    await expect(row).toContainText("Harga lama ke CV Zqbc Lain belum dinaikkan");
    await expect(row.getByRole("button", { name: /Jelaskan/ })).toHaveCount(0);

    await row.getByRole("link", { name: "Perlu diperbaiki ›" }).click();
    const task = page.getByRole("listitem").filter({ hasText: "Harga lama ke CV Zqbc Lain" });
    await expect(task).toContainText("Jual di bawah beli");
    await expect(task).toContainText("SI.2026.09.09202 · CV Zqbc Lain · 2026-09-04 · jual Rp 8.000/Pcs, beli Rp 10.000 (PI.2026.09.09201) · rugi Rp 10.000");
    await expect(task.getByRole("button", { name: "Buka analisa SI" })).toBeVisible();
    await page.screenshot({ path: "test-results/below-cost-explain-task-light.png", fullPage: true });
    await task.getByRole("button", { name: "Tandai selesai" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("Harga klien dinaikkan mulai Oktober.");
    await page.getByRole("dialog").getByRole("button", { name: /selesai/i }).last().click();
    await expect(task).toHaveCount(0);

    const again = await open(page);
    await expect(again).toContainText("Task selesai");
    await expect(again).toContainText("Harga klien dinaikkan mulai Oktober.");
    await expect(again.getByRole("button", { name: "Jelaskan SI.2026.09.09202 ZQBC-1" })).toBeVisible();
  });
});

test.describe("dark", () => {
  test.use({ theme: "dark" });
  test("an explained row reads in dark mode", async ({ page, errors }) => {
    void errors;
    const row = await open(page);
    await expect(row).toContainText("Task selesai");
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/below-cost-explain-dark.png", fullPage: true });
  });
});
