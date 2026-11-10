/* Dari list klien: one box per row picks the item (components/ItemCombobox.tsx). Suggestions first,
   typing searches the catalog, [+] adds one more item for the request as its own quote line with
   its own COGS (Ryoma, 9 Nov: "binder clip" bisa 5 pilihan). */

import { csvFile, expect, test } from "./helpers";

test.use({ theme: "light" });

test("a row with two extra items makes three quote lines, each with its own COGS", async ({ page, errors }) => {
  void errors;
  const LIST = csvFile("binder.csv", [["Nama Barang", "Qty", "Satuan"], ["Kertas HVS Sinar Dunia A4 70gr", "5", "Rim"]]);
  await page.goto("/");
  await page.getByRole("button", { name: "Dari list klien" }).click();
  await page.locator('input[type="file"]').setInputFiles(LIST);

  const box = page.getByRole("combobox", { name: "Item katalog untuk Kertas HVS Sinar Dunia A4 70gr" });
  await expect(box).toHaveValue(/SINAR DUNIA/);
  await box.fill("lakban");
  await page.getByRole("button", { name: "Tambah LAKBAN BENING 48MM sebagai barang lain" }).click();
  // Its own row, with its own COGS (admin sees costs), not folded into the request's row.
  const lakban = page.locator("tr.also-row", { hasText: "LAKBAN BENING 48MM" });
  await expect(lakban).toBeVisible();
  await expect(lakban.locator("td.num").nth(1)).not.toHaveText(await page.locator("tbody tr").first().locator("td.num").nth(1).innerText());
  await box.fill("kertas");
  await page.getByRole("button", { name: "Tambah KERTAS HVS BOLA DUNIA A4 70GR sebagai barang lain" }).click();
  await expect(page.locator("tr.also-row")).toHaveCount(2);
  // Adding never changed the row's own pick.
  await box.press("Escape");
  await expect(box).toHaveValue(/SINAR DUNIA/);

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

test("one box: suggestions, search, pick, clear; closes on Escape, outside click and another row", async ({ page, errors }) => {
  void errors;
  const LIST = csvFile("dua.csv", [["Nama Barang", "Qty", "Satuan"], ["Kertas HVS Sinar Dunia A4 70gr", "5", "Rim"], ["Lakban bening", "2", "Roll"]]);
  await page.goto("/");
  await page.getByRole("button", { name: "Dari list klien" }).click();
  await page.locator('input[type="file"]').setInputFiles(LIST);
  const kertas = page.getByRole("combobox", { name: "Item katalog untuk Kertas HVS Sinar Dunia A4 70gr" });
  const lakban = page.getByRole("combobox", { name: "Item katalog untuk Lakban bening" });
  const list = page.getByRole("listbox");

  // No dropdown, no magnifier, no "+ Barang lain": one box per row.
  await expect(page.locator("select[aria-label^='Item katalog']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Cari di katalog untuk/ })).toHaveCount(0);

  await kertas.click();
  await expect(list).toBeVisible();
  await expect(list.getByRole("option").first()).toContainText("KERTAS HVS SINAR DUNIA A4 70GR");
  await kertas.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Quotation dari list klien" })).toBeVisible();

  // Keyboard: type, arrow, Enter picks.
  await kertas.fill("kertas bola");
  await expect(list.getByRole("option").first()).toContainText("BOLA DUNIA");
  await kertas.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(kertas).toHaveValue(/BOLA DUNIA/);

  // Moving to another row closes the open box; only one is open.
  await kertas.click();
  await expect(list).toHaveCount(1);
  await lakban.click();
  await expect(list).toHaveCount(1);
  await expect(list.getByRole("option").first()).toContainText("LAKBAN");
  await page.getByLabel("Judul quotation").click();
  await expect(list).toHaveCount(0);

  // × leaves the row out.
  await page.getByRole("button", { name: "Kosongkan pilihan untuk Lakban bening" }).click();
  await expect(lakban).toHaveValue("");
});
