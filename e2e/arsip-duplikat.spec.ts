/* Arsip barang (2026-11-25): Admin meng-ACC laporan Duplikat; barang yang kalah masuk Arsip, hilang dari
   Katalog, dan status "Nonaktifkan di Accurate" tampil di kartu Riwayat. Pulihkan mengembalikannya. */

import { expect, importCatalog, test } from "./helpers";

test.use({ theme: "light" });

test("ACC Duplikat mengarsipkan barang kembar; tampil di Arsip; Pulihkan", async ({ page, errors }) => {
  void errors;
  await importCatalog(page.request, [
    { code: "ZQARS-1", name: "ZQARS KABEL ROLL 10M", cogs: 100, list_price: 200 },
    { code: "ZQARS-2", name: "ZQARS KABEL ROLL 10 M", cogs: 100, list_price: 200 },
  ], "arsip-e2e");
  const found = await (await page.request.get("/api/catalog?q=ZQARS")).json();
  const ids = found.items.map((i: { id: number }) => i.id);
  expect(ids).toHaveLength(2);
  const rep = await page.request.post("/api/duplicate-reports", { data: { item_ids: ids, note: "beda spasi" } });
  expect(rep.status()).toBe(201);

  await page.goto("/gudang");
  await page.getByRole("button", { name: /Menunggu ACC Duplikat/ }).click();
  const card = page.getByRole("listitem").filter({ hasText: "ZQARS KABEL ROLL" }).first();
  await card.getByRole("button", { name: "ACC", exact: true }).click();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Laporan di-ACC.")).toBeVisible();

  await page.getByRole("button", { name: "Riwayat", exact: true }).click();
  const done = page.getByRole("listitem").filter({ hasText: "ZQARS KABEL ROLL" }).first();
  await expect(done).toContainText("Diarsip");
  await expect(done).toContainText("Nonaktifkan di Accurate: belum");
  await page.screenshot({ path: test.info().outputPath("riwayat-duplikat.png") });

  await page.goto("/catalog");
  await page.getByLabel("Cari katalog").fill("ZQARS");
  await expect(page.getByText("ZQARS-1").first()).toBeVisible();
  await expect(page.getByText("ZQARS-2")).toHaveCount(0);

  await page.getByRole("button", { name: "Arsip", exact: true }).click();
  const arsip = page.getByTestId("catalog-archive");
  await expect(arsip).toContainText("Duplikat dari");
  await arsip.getByRole("button", { name: "Sudah dinonaktifkan" }).click();
  await expect(arsip).toContainText("Nonaktifkan di Accurate: sudah");
  await page.screenshot({ path: test.info().outputPath("arsip-katalog.png") });

  await arsip.getByRole("button", { name: "Pulihkan" }).click();
  await expect(page.getByText(/dipulihkan ke katalog/)).toBeVisible();
  await page.getByRole("button", { name: "Kembali ke katalog" }).click();
  await page.getByLabel("Cari katalog").fill("ZQARS");
  await expect(page.getByText("ZQARS-2").first()).toBeVisible();
});
