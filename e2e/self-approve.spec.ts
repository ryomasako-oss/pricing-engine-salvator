/* A block breach means the quote can't be approved by its author (shared/policy.ts).
   The server answers 403; the decide dialog says so up front instead of offering Setujui. */

import { expect, test } from "./helpers";

test("the author of a blocked quote sees Setujui disabled, Tolak still available", async ({ page, errors }) => {
  void errors;
  const snapshot = {
    assumptions: {
      opex: 0.08, targetMargin: 0.05, leaderMargin: 0, profitDiscount: 0, rrpDiscount: 0.1,
      marginFloor: 0.05, ppn: 0.11, step: 50, months: 12, includeLogistics: false,
    },
    items: [{ id: "it1", lineNo: 1, code: "", name: "Kertas A4 80gsm", uom: "rim", qty: 100, cogs: 38000, rrp: 55000, role: "CORE" }],
    regions: [],
    meta: { quoteNo: "", date: "2026-01-01", validity: 30, payment: "", delivery: "", notes: "", paymentDays: 30, warrantyYears: 1 },
    scenario: 0,
  };
  const created = await page.request.post("/api/quotes", { data: { title: "E2E setujui sendiri", snapshot } });
  expect(created.ok()).toBe(true);
  const { quote } = (await created.json()) as { quote: { id: number } };
  const submitted = await page.request.post(`/api/quotes/${quote.id}/submit`);
  expect(submitted.ok()).toBe(true);
  expect(((await submitted.json()) as { quote: { status: string } }).quote.status).toBe("submitted");

  await page.goto(`/quotes/${quote.id}`);
  await page.getByRole("button", { name: "Putuskan" }).click();
  const modal = page.locator(".modal");
  await expect(modal.getByRole("button", { name: "Setujui" })).toBeDisabled();
  await expect(modal.getByText("harus disetujui manajer/admin lain")).toBeVisible();
  await modal.getByRole("textbox").fill("Naikkan harga");
  await expect(modal.getByRole("button", { name: "Tolak" })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("self-approve.png") });
});
