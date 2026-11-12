/* Riwayat Audit (/audit): a catalog edit shows old → new, a failed login is recorded without the
   password, filters narrow the list, and Export Excel takes the filtered rows. Managers and admins only. */

import { readFileSync } from "node:fs";
import { request as pwRequest } from "@playwright/test";
import * as XLSX from "xlsx";
import { expect, test } from "./helpers";

const CODE = "ZQAU-1";
const WRONG = "salah-sandi-e2e";
// Same WIB day the page defaults its "Sampai" date to.
const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

test.beforeAll(async ({ baseURL }) => {
  // Always the admin: the sales describe below runs this hook too, with its own storage state.
  const request = await pwRequest.newContext({ baseURL, storageState: "e2e/.auth/admin.json" });
  const imported = await request.post("/api/catalog/import", {
    data: { rows: [{ code: CODE, name: "ZQAU BUKU AUDIT", category: "GENERAL", cogs: 10000, list_price: 15000 }], source: "e2e" },
  });
  expect(imported.ok()).toBe(true);
  const { items } = await (await request.get(`/api/catalog?q=${CODE}`)).json();
  const item = items.find((i: { code: string }) => i.code === CODE);
  const edited = await request.put(`/api/catalog/${item.id}`, {
    data: { name: item.name, uom: item.uom, cogs: 12500, list_price: item.list_price, category: item.category },
  });
  expect(edited.ok()).toBe(true);
  await request.dispose();

  // A fresh context, so the failed attempt carries no session.
  const anon = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const failed = await anon.post("/api/auth/login", { data: { email: "Tamu.Audit@e2e.test", password: WRONG } });
  expect(failed.status()).toBe(401);
  await anon.dispose();
});

async function open(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Riwayat", exact: true }).click();
  await page.getByRole("navigation", { name: "Jenis riwayat" }).getByRole("link", { name: "Audit" }).click();
  await expect(page.getByLabel("Tanggal sampai")).toHaveValue(today);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`a catalog edit reads old → new (${theme})`, async ({ page, errors }) => {
      void errors;
      await open(page);
      await page.getByLabel("Cari di riwayat audit").fill(CODE);
      await expect(page.getByRole("row").filter({ hasText: "Impor" })).toHaveCount(0);
      const row = page.getByRole("row", { name: /COGS: 10\.000 → 12\.500/ });
      await expect(row).toContainText("Katalog");
      await expect(row).toContainText("Diubah");
      await expect(row).toContainText(`Kode: ${CODE}`);
      await page.screenshot({ path: `test-results/audit-log-${theme}.png`, fullPage: true });
    });
  });
}

test.use({ theme: "light" });

test("a failed login is recorded with the email, never the password", async ({ page, errors }) => {
  void errors;
  await open(page);
  await page.getByLabel("Jenis data").selectOption("user");
  const row = page.getByRole("row", { name: /Gagal masuk/ }).filter({ hasText: "tamu.audit@e2e.test" });
  await expect(row).toHaveCount(1);
  await expect(page.getByRole("table")).not.toContainText(WRONG);
});

test("filters narrow the list, and Export Excel takes the filtered rows", async ({ page, errors }) => {
  void errors;
  await open(page);
  await page.getByLabel("Cari di riwayat audit").fill(CODE);
  // The search waits half a second after typing: wait until the import row (no code in it) is gone.
  await expect(page.getByRole("row").filter({ hasText: "Impor" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /COGS: 10\.000 → 12\.500/ })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export Excel" }).click()]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^riwayat-audit-\\d{4}-\\d{2}-\\d{2}-sd-${today}\\.xlsx$`));
  const wb = XLSX.read(readFileSync((await download.path())!));
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => String(r["Detail asli"]).includes(CODE))).toBe(true);
  expect(rows).toContainEqual(expect.objectContaining({ Data: "Katalog", Aksi: "Diubah", Keterangan: expect.stringContaining("COGS: 10.000 → 12.500") }));

  await page.getByLabel("Jenis data").selectOption("quote");
  await expect(page.getByRole("heading", { name: "Tidak ada catatan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export Excel" })).toBeDisabled();
});

test.describe("sales", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });
  test("cannot open Riwayat Audit or its API", async ({ page, errors }) => {
    void errors;
    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: "Riwayat audit" })).toHaveCount(0);
    const r = await page.request.get(`/api/approvals/audit?from=${today}&to=${today}`);
    expect(r.status()).toBe(403);
  });
});
