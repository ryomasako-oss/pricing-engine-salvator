/* Pencarian barang ala mesin cari (shared/catalogSearch.ts): words in any order, the priority
   brand first, and a typo answered with a suggestion that can be clicked. */

import { expect, test } from "./helpers";

test.use({ theme: "light" });

const ROWS = [
  { code: "ZQS-1", name: "ZQSRC PULPEN GEL HITAM", category: "GENERAL", cogs: 1000, list_price: 2000 },
  { code: "ZQS-2", name: "ZQSRC ARTLINE PULPEN HITAM", category: "ARTLINE", cogs: 1000, list_price: 2000 },
  { code: "ZQS-3", name: "ZQSRC STABILO KUNING", category: "GENERAL", cogs: 1000, list_price: 2000 },
];

test.beforeAll(async ({ request }) => {
  const r = await request.post("/api/catalog/import", { data: { rows: ROWS, source: "e2e" } });
  expect(r.ok()).toBe(true);
});

test("quotation picker: any word order, Artline first, typo suggestion", async ({ page, errors }) => {
  void errors;
  const { quote } = await (await page.request.post("/api/quotes", { data: { title: "E2E cari" } })).json();
  await page.goto(`/quotes/${quote.id}`);
  await page.getByRole("button", { name: "Pilih dari katalog" }).first().click();
  const box = page.getByLabel("Cari katalog");
  await box.fill("hitam zqsrc pulpen");
  const names = page.locator(".modal .cell-title");
  await expect(names).toHaveText(["ZQSRC ARTLINE PULPEN HITAM", "ZQSRC PULPEN GEL HITAM"]);

  await box.fill("zqsrc stablio");
  await expect(names).toHaveText(["ZQSRC STABILO KUNING"]);
  await page.getByRole("button", { name: "zqsrc stabilo" }).click();
  await expect(box).toHaveValue("zqsrc stabilo");
  await expect(page.getByText("Mungkin maksud Anda")).toHaveCount(0);
});

test("Katalog page: relevance order while searching", async ({ page, errors }) => {
  void errors;
  await page.goto("/catalog");
  await page.getByLabel("Cari katalog").fill("pulpen zqsrc");
  await expect(page.getByText("ZQSRC ARTLINE PULPEN HITAM")).toBeVisible();
  const first = page.locator("tbody tr").first();
  await expect(first).toContainText("ZQSRC ARTLINE PULPEN HITAM");
});
