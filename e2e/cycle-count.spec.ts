/* Stok pembanding / stok mandiri (2026-11-25): di Katalog pilih gudang + pemilik (Umum) dan isi hasil hitung → draf di
   Gudang → ACC → masuk stok pembanding barang itu, tanpa mengubah Accurate. Hanya Admin dan Admin Gudang. */

import { expect, test } from "./helpers";

test("hitung di Katalog → ACC → stok pembanding", async ({ page, errors }) => {
  void errors;
  const list = await (await page.request.get("/api/catalog?q=")).json();
  const item = list.items[0] as { id: number; code: string; name: string };

  await page.goto(`/catalog?q=${encodeURIComponent(item.code)}`);
  await page.getByRole("button", { name: new RegExp(`Satuan dan barcode ${item.name}`) }).first().click();
  const box = page.getByRole("textbox", { name: new RegExp(`Hasil hitung ${item.name} di Utama`) });
  await box.fill("7");
  await page.screenshot({ path: test.info().outputPath("stok-mandiri-isian.png") });
  await page.getByRole("button", { name: /Ajukan hitungan/ }).click();
  await expect(page.getByText(/hitungan menunggu ACC: Utama 7/)).toBeVisible();

  await page.goto("/gudang");
  const card = page.getByRole("listitem").filter({ hasText: item.code }).filter({ hasText: /Hitung Utama: 7/ }).first();
  await expect(card).toContainText("stok pembanding (mandiri), tidak mengubah Accurate");
  await card.getByRole("button", { name: /^ACC/ }).first().click();
  await expect(page.getByRole("region", { name: "Belum masuk Accurate" })).toHaveCount(0);
  await page.goto(`/catalog?q=${encodeURIComponent(item.code)}`);
  await page.getByRole("button", { name: new RegExp(`Satuan dan barcode ${item.name}`) }).first().click();
  await expect(page.getByText(/Utama: 7/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("stok-mandiri-saldo.png") });
  const counts = await (await page.request.get(`/api/stock/counts?code=${encodeURIComponent(item.code)}`)).json();
  expect(counts.counts[0]).toMatchObject({ warehouse: "Utama", owner: "umum", counted: 7, status: "recorded" });
});
