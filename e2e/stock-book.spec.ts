/* Gudang › Stok pembanding (2026-11-25): tabel seluruh stok mandiri, kolom per gudang + pemilik, Accurate PT pembanding. */

import { expect, test } from "./helpers";

test("hitungan yang di-ACC tampil di tabel stok pembanding", async ({ page, errors }) => {
  void errors;
  const item = (await (await page.request.get("/api/catalog?q=")).json()).items[4] as { id: number; code: string; name: string };
  await page.request.put(`/api/catalog/${item.id}/stock`, { data: { counts: [{ warehouse: "Utama", stock: 12 }, { warehouse: "GUDANG AKR SURABAYA", owner: "cv", stock: 5 }] } });
  const d = ((await (await page.request.get("/api/catalog/drafts")).json()).drafts as { id: number; code: string }[]).find((x) => x.code === item.code)!;
  expect((await page.request.post(`/api/catalog/drafts/${d.id}/review`, { data: { approve: true } })).ok()).toBe(true);

  await page.goto("/gudang");
  await page.getByRole("button", { name: "Stok pembanding" }).click();
  await expect(page.getByRole("columnheader", { name: "Utama · Umum" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "GUDANG AKR SURABAYA · CV" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: item.code });
  await expect(row).toContainText("12");
  await expect(row).toContainText("17");
  await page.screenshot({ path: test.info().outputPath("tabel-stok-pembanding.png"), fullPage: true });
});
