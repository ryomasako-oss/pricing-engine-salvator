/* Impor katalog lewat ACC (2026-11-20): an uploaded file only makes drafts. Katalog shows the
   "masuk draf" message and the catalog is unchanged; Gudang groups the file and "ACC seluruh file"
   puts it in the catalog. */

import { csvFile, expect, test } from "./helpers";

test.use({ theme: "light" });

const CODE = "ZQACC-1";

test("unggah → Gudang → ACC seluruh file", async ({ page, errors }) => {
  void errors;
  const file = csvFile("katalog-acc-e2e.csv", [
    ["Kode Barang", "Nama Barang", "COGS", "Harga Jual"],
    [CODE, "ZQACC PENGGARIS BARU", "1000", "2000"],
    ["ZQACC-2", "ZQACC PENGHAPUS BARU", "500", "900"],
  ]);

  await page.goto("/catalog");
  await page.getByRole("button", { name: "Impor" }).click();
  await page.getByRole("menuitem", { name: /Katalog lengkap \(gabung\)/ }).click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("File masuk draf (2 barang), menunggu ACC admin di menu Gudang.")).toBeVisible();
  await page.getByRole("button", { name: "Selesai" }).click();

  // Nothing in the catalog yet.
  const before = await (await page.request.get(`/api/catalog?q=${CODE}`)).json();
  expect(before.items.some((i: { code: string }) => i.code === CODE)).toBe(false);

  await page.goto("/gudang");
  const card = page.getByRole("listitem").filter({ hasText: "katalog-acc-e2e.csv" }).first();
  await expect(card).toContainText("Gabung ke katalog");
  await expect(card).toContainText("2 barang menunggu");
  await card.getByRole("button", { name: "Lihat isi" }).click();
  await expect(card).toContainText("ZQACC PENGGARIS BARU");
  await expect(card).toContainText("Barang baru");

  await card.getByRole("button", { name: "ACC seluruh file" }).click();
  await expect(page.getByText("2 barang dari katalog-acc-e2e.csv di-ACC")).toBeVisible();
  await expect(page.getByText("katalog-acc-e2e.csv")).toHaveCount(1); // only the toast: the file left the waiting list

  const after = await (await page.request.get(`/api/catalog?q=${CODE}`)).json();
  expect(after.items.find((i: { code: string }) => i.code === CODE)).toMatchObject({ name: "ZQACC PENGGARIS BARU", cogs: 1000, list_price: 2000 });
});
