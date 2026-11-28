/* Surat perubahan harga: from a real-loss row in Jual < Beli to the analysis, a draft letter, and its PDF.
   The ACC by another manager is covered by the route tests (server/worker/priceLetters.test.ts). */

import { readFileSync } from "node:fs";
import { expect, test } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("light", () => {
  test.use({ theme: "light" });
  test("a real loss: analysis, suggested price, draft letter, PDF (light)", async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto("/below-cost");
    await page.getByLabel("Tanggal SI dari").fill("2026-09-01");
    await page.getByLabel("Tanggal SI sampai").fill("2026-09-30");
    // 09201 is a PPN slip: no letter. 09202 has no explanation: a real loss.
    await expect(
      page.getByRole("link", { name: "Analisa dan surat SI.2026.09.09201" }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Analisa dan surat SI.2026.09.09202" })
      .click();

    await expect(
      page.getByRole("heading", { name: "Analisa rugi SI.2026.09.09202" }),
    ).toBeVisible();
    const form = page.getByRole("region", { name: "Surat perubahan harga" });
    // 10.000 x 1,08 / 0,85 = 12.705,9 -> 12.750 per Pcs.
    await expect(page.getByLabel("Harga baru ZQBC-1")).toHaveValue("12750");
    await expect(form).toContainText("Rp 8.000");
    await page.getByLabel("Harga baru ZQBC-1").fill("9000");
    await expect(form.getByRole("alert")).toContainText("tetap rugi");
    await expect(
      form.getByRole("button", { name: "Simpan draft surat" }),
    ).toBeDisabled();
    await page.getByLabel("Harga baru ZQBC-1").fill("13000");
    await page.screenshot({
      path: "test-results/price-letter-analysis-light.png",
      fullPage: true,
    });
    await form.getByRole("button", { name: "Simpan draft surat" }).click();

    await expect(
      page.getByRole("heading", { name: /^SIP\/SPH\/\d{4}\/\d{3}$/ }),
    ).toBeVisible();
    await expect(page.getByText("Menunggu ACC").first()).toBeVisible();
    // The author can't ACC their own letter, only withdraw it.
    await expect(page.getByRole("button", { name: "ACC surat" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Tolak" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Isi surat" })).toContainText(
      "Rp 13.000",
    );

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Unduh PDF" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^SIP-SPH-\d{4}-\d{3}\.pdf$/);
    expect(
      readFileSync((await download.path())!)
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    await download.saveAs("test-results/price-letter.pdf");

    await page
      .getByRole("navigation", { name: "Jenis riwayat" })
      .getByRole("link", { name: "Surat harga" })
      .click();
    await expect(
      page.getByRole("row", { name: /SI\.2026\.09\.09202/ }),
    ).toContainText("Menunggu ACC");
  });
});

test.describe("dark", () => {
  test.use({ theme: "dark" });
  test("the letter list and detail read in dark mode; a second letter for the SI is not offered", async ({
    page,
    errors,
  }) => {
    void errors;
    await page.goto("/surat-harga");
    await page.screenshot({
      path: "test-results/price-letter-list-dark.png",
      fullPage: true,
    });
    await page
      .getByRole("row", { name: /SI\.2026\.09\.09202/ })
      .getByRole("link")
      .click();
    await page.screenshot({
      path: "test-results/price-letter-detail-dark.png",
      fullPage: true,
    });
    await page.getByRole("link", { name: "Analisa SI.2026.09.09202" }).click();
    await expect(page.getByText("Sudah ada surat untuk SI ini")).toBeVisible();
    await page.screenshot({
      path: "test-results/price-letter-analysis-dark.png",
      fullPage: true,
    });
  });
});
