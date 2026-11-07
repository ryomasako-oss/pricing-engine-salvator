/* Each row of the quotation's totals block can be left off on its own
   (Ryoma, 2026-11-07): e.g. drop the contract value but keep the monthly total. */

import { expect, test, THEMES } from "./helpers";

for (const theme of THEMES) {
  test.describe(theme, () => {
  test.use({ theme });
  test(`hide only the contract value, keep the monthly total (${theme})`, async ({ page, errors }) => {
    void errors;
    const created = await page.request.post("/api/quotes", { data: { title: `E2E baris total ${theme}` } });
    const { quote } = (await created.json()) as { quote: { id: number } };

    await page.goto(`/quotes/${quote.id}`);
    await page.getByRole("button", { name: "Dokumen", exact: true }).click();
    const totals = page.locator(".quote-totals").last();
    await expect(totals).toContainText("Nilai kontrak");

    await page.getByRole("checkbox", { name: "Nilai kontrak" }).uncheck();
    await expect(totals).not.toContainText("Nilai kontrak");
    await expect(totals).toContainText("Total per bulan");
    await expect(totals).toContainText("Subtotal per bulan");

    const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/quotes/${quote.id}`));
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    expect((await put).status()).toBe(200);

    await page.reload();
    await page.getByRole("button", { name: "Dokumen", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Nilai kontrak" })).not.toBeChecked();
    await expect(page.locator(".quote-totals").last()).not.toContainText("Nilai kontrak");
    await page.getByRole("checkbox", { name: "Nilai kontrak" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/doc-total-rows-${theme}.png`, fullPage: true });
  });
  });
}
