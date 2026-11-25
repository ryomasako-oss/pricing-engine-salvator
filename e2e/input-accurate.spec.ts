/* Gudang › Input ke Accurate (2026-11-25): stok yang sudah di-ACC muncul dengan selisih yang perlu diinput
   ke Accurate; "Sudah diinput di Accurate" mengeluarkannya dari daftar. */

import { expect, test } from "./helpers";

test("ACC stok → tab Input ke Accurate → Sudah diinput", async ({ page, errors }) => {
  void errors;
  const list = await (await page.request.get("/api/catalog?q=")).json();
  const item = list.items[0] as { id: number; code: string; name: string; stock: number };
  expect((await page.request.put(`/api/catalog/${item.id}/stock`, { data: { stock: item.stock + 3 } })).ok()).toBe(true);
  const drafts = (await (await page.request.get("/api/catalog/drafts")).json()).drafts as { id: number; code: string; kind: string }[];
  const d = drafts.find((x) => x.code === item.code && x.kind === "stock")!;
  expect((await page.request.post(`/api/catalog/drafts/${d.id}/review`, { data: { approve: true } })).ok()).toBe(true);

  await page.goto("/gudang");
  const tab = page.getByRole("button", { name: /Input ke Accurate/ });
  await expect(tab).toContainText("1");
  await tab.click();
  const row = page.getByRole("row").filter({ hasText: item.code });
  await expect(row).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("input-accurate-list.png"), fullPage: true });

  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sudah diinput di Accurate \(1\)/ }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("uji e2e");
  await page.screenshot({ path: test.info().outputPath("input-accurate-confirm.png") });
  await page.getByRole("button", { name: "Ya, sudah diinput" }).click();
  await expect(page.getByText("Tidak ada yang perlu diinput")).toBeVisible();

  await page.getByRole("button", { name: "Riwayat stok" }).click();
  await expect(page.getByText(/Tercatat di Accurate · ditandai/).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("input-accurate-history.png"), fullPage: true });
});
