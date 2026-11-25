/* Cycle count (2026-11-25): pilih gudang + hasil hitung di Katalog → draf di Gudang menunjukkan selisih dengan Accurate
   → ACC → kartu "Belum masuk Accurate" → "Sudah masuk Accurate" → stok pembanding barang itu. */

import { expect, test } from "./helpers";

test("hitung di Katalog → ACC → Belum masuk Accurate → Sudah masuk", async ({ page, errors }) => {
  void errors;
  const list = await (await page.request.get("/api/catalog?q=")).json();
  const item = list.items[0] as { id: number; code: string; name: string };
  const wh = ((await (await page.request.get("/api/stock/warehouses")).json()).warehouses as string[])[0] ?? "Utama";
  const put = await page.request.put(`/api/catalog/${item.id}/stock`, { data: { stock: 7, warehouse: wh } });
  expect(put.ok()).toBe(true);

  await page.goto("/gudang");
  const card = page.getByRole("listitem").filter({ hasText: item.code }).filter({ hasText: /Hitung / }).first();
  await expect(card).toContainText(`Hitung ${wh}: 7`);
  await page.screenshot({ path: test.info().outputPath("cycle-draft.png"), fullPage: true });
  await card.getByRole("button", { name: /^ACC/ }).first().click();

  const section = page.getByRole("region", { name: "Belum masuk Accurate" });
  await expect(section).toContainText(item.code);
  await page.screenshot({ path: test.info().outputPath("cycle-open.png"), fullPage: true });
  await section.getByRole("checkbox", { name: `Pilih ${item.name}` }).check();
  await section.getByRole("button", { name: /Sudah masuk Accurate \(1\)/ }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("IA.UJI");
  await page.getByRole("button", { name: "Ya, sudah masuk" }).click();
  await expect(section).toHaveCount(0);

  const counts = await (await page.request.get(`/api/stock/counts?code=${encodeURIComponent(item.code)}`)).json();
  expect(counts.counts[0]).toMatchObject({ warehouse: wh, counted: 7, status: "entered", entered_how: "manual", entered_ref: "IA.UJI" });
});
