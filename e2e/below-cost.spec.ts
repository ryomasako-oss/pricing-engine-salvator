/* Jual di bawah beli: SI lines sold under the PI price of their date, a filter, and an Excel export
   of the filtered rows. Managers and admins only. */

import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { expect, test } from "./helpers";

async function open(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Riwayat", exact: true }).click();
  await page.getByRole("navigation", { name: "Jenis riwayat" }).getByRole("link", { name: "Jual < Beli" }).click();
  await expect(page.getByRole("heading", { name: "Jual di bawah beli" })).toBeVisible();
  await page.getByLabel("Tanggal SI dari").fill("2026-09-01");
  await page.getByLabel("Tanggal SI sampai").fill("2026-09-30");
}

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`an SI under its PI price, with the loss (${theme})`, async ({ page, errors }) => {
      void errors;
      await open(page);
      const row = page.getByRole("row", { name: /SI\.2026\.09\.09201/ });
      await expect(row).toContainText("ZQBC MAP PLASTIK");
      await expect(row).toContainText("Rp 9.000");
      await expect(row).toContainText("PI.2026.09.09201");
      await expect(row).toContainText("Rp 10.000"); // (10.000 - 9.000) x 10
      await page.screenshot({ path: `test-results/below-cost-${theme}.png`, fullPage: true });
    });
  });
}

test.use({ theme: "light" });

test("filters by client and text, and exports only the filtered rows", async ({ page, errors }) => {
  void errors;
  await open(page);
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.0920[12]/ })).toHaveCount(2);

  await page.getByLabel("Filter klien").selectOption("CV Zqbc Lain");
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09201/ })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09202/ })).toBeVisible();
  await expect(page.getByText("terfilter dari")).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export Excel" }).click()]);
  expect(download.suggestedFilename()).toBe("jual-di-bawah-beli-2026-09-01-sd-2026-09-30.xlsx");
  const wb = XLSX.read(readFileSync((await download.path())!));
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
  expect(rows).toEqual([
    expect.objectContaining({ "Nomor SI": "SI.2026.09.09202", Klien: "CV Zqbc Lain", "Harga Jual (sebelum PPN)": 8000, "Harga Beli PI (sebelum PPN)": 10000, "Selisih Rugi": 10000 }),
  ]);

  await page.getByLabel("Filter klien").selectOption("");
  await page.getByLabel("Filter laporan").fill("tidak ada yang cocok");
  await expect(page.getByRole("heading", { name: "Tidak ada baris yang cocok dengan filter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Excel" })).toBeDisabled();
});

test("marks rows that look like a PPN or unit slip, and filters them", async ({ page, errors }) => {
  void errors;
  await open(page);
  // 9.000 against 10.000 is the 11% of PPN; 8.000 against 10.000 is no slip.
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09201/ })).toContainText("Cek PPN");
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09202/ })).not.toContainText("Cek PPN");
  await expect(page.getByText("1 di antaranya mungkin salah data")).toBeVisible();

  await page.getByLabel("Filter cek data").selectOption("slip");
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09201/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09202/ })).toHaveCount(0);
  await page.getByLabel("Filter cek data").selectOption("clean");
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09201/ })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /SI\.2026\.09\.09202/ })).toBeVisible();
});

test.describe("sales", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });
  test("cannot open Jual < Beli", async ({ page, errors }) => {
    void errors;
    await page.goto("/below-cost");
    await expect(page.getByRole("heading", { name: "Jual di bawah beli" })).toHaveCount(0);
  });
});
