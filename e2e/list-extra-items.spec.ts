/* One request, several items (Ryoma, 9 Nov: "binder clip" bisa 5 pilihan): "+ Barang lain" adds more
   catalog items to a row of Dari list klien, each its own quote line under the row's own pick. */

import { csvFile, expect, test } from "./helpers";

test.use({ theme: "light" });

test("a row with two extra items makes three quote lines", async ({ page, errors }) => {
  void errors;
  const LIST = csvFile("binder.csv", [["Nama Barang", "Qty", "Satuan"], ["Kertas HVS Sinar Dunia A4 70gr", "5", "Rim"]]);
  await page.goto("/");
  await page.getByRole("button", { name: "Dari list klien" }).click();
  await page.locator('input[type="file"]').setInputFiles(LIST);

  const row = "Kertas HVS Sinar Dunia A4 70gr";
  // The magnifier opens the search; "+ Tambah" adds an item beside the row's own pick.
  await page.getByRole("button", { name: `Cari di katalog untuk ${row}` }).click();
  const box = page.getByLabel("Kata kunci katalog");
  await box.fill("lakban");
  await page.getByRole("button", { name: "Tambah LAKBAN BENING 48MM sebagai barang lain" }).click();
  // Its own row, with its own COGS (admin sees costs), not folded into the request's row.
  const lakban = page.locator("tr.also-row", { hasText: "LAKBAN BENING 48MM" });
  await expect(lakban).toBeVisible();
  await expect(lakban.locator("td.num").nth(1)).not.toHaveText(await page.locator("tbody tr").first().locator("td.num").nth(1).innerText());
  await box.fill("kertas");
  await page.getByRole("button", { name: "Tambah KERTAS HVS BOLA DUNIA A4 70GR sebagai barang lain" }).click();
  await expect(page.locator("tr.also-row")).toHaveCount(2);

  await expect(page.getByText(/^3 item masuk/)).toBeVisible();
  await page.getByLabel("Judul quotation").fill("Barang lain e2e");
  await page.getByRole("button", { name: /Buat quotation/ }).click();
  await expect(page.getByRole("button", { name: /Buat quotation/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/quotes\/\d+$/);
  const id = Number(page.url().split("/").pop());
  const { quote } = (await (await page.request.get(`/api/quotes/${id}`)).json()) as { quote: { items: { name: string }[] } };
  expect(quote.items).toHaveLength(3);
  expect(quote.items[0].name).toMatch(/SINAR DUNIA/);
  expect(quote.items[1].name).toMatch(/LAKBAN BENING 48MM/);
});
