/* On a phone (390px) no page may scroll sideways: wide tables turn into cards
   (.table.stack) or scroll inside their own .table-wrap, never the whole page. */

import { expect, test, type Theme } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, theme: "light" as Theme });

const PAGES = [
  "/quotes",
  "/approvals",
  "/perbaikan",
  "/pencocokan",
  "/catalog",
  "/cogs-history",
  "/sales-history",
  "/clients",
  ...["kebijakan", "identitas", "excel", "notifikasi", "sandi", "pengguna", "reset"].map((b) => `/settings?bagian=${b}`),
];

async function expectNoSideScroll(page: import("@playwright/test").Page, where: string) {
  await page.locator("main").waitFor();
  await page.waitForLoadState("networkidle");
  const { scroll, view } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(scroll, `${where} scrolls sideways`).toBeLessThanOrEqual(view);
}

for (const path of PAGES) {
  test(`phone: ${path} fits the screen`, async ({ page, errors }) => {
    void errors;
    await page.goto(path);
    await expectNoSideScroll(page, path);
  });
}

test("phone: quote editor tabs fit the screen", async ({ page, errors }) => {
  void errors;
  const created = await page.request.post("/api/quotes", { data: { title: "E2E HP" } });
  const { quote } = (await created.json()) as { quote: { id: number } };
  await page.goto(`/quotes/${quote.id}`);
  // One item row, so the items table is on screen too.
  await page.getByRole("button", { name: "Baris kosong" }).first().click();
  await expect(page.getByLabel("Nama item baris 1")).toBeVisible();
  await expectNoSideScroll(page, "editor");
  const tabs = page.getByRole("group", { name: "Bagian penawaran" }).getByRole("button");
  expect(await tabs.count()).toBeGreaterThan(3);
  for (const tab of await tabs.all()) {
    const name = await tab.innerText();
    await tab.click();
    await expectNoSideScroll(page, `editor tab ${name}`);
  }
});

test.describe("sales", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });
  for (const path of ["/quotes", "/catalog", "/clients", "/settings?bagian=identitas"]) {
    test(`phone (sales): ${path} fits the screen`, async ({ page, errors }) => {
      void errors;
      await page.goto(path);
      await expectNoSideScroll(page, path);
    });
  }
  test("phone (sales): quote page fits the screen", async ({ page, errors }) => {
    void errors;
    const { quote } = await (await page.request.post("/api/quotes", { data: { title: "E2E HP sales" } })).json();
    await page.goto(`/quotes/${quote.id}`);
    await expect(page.getByLabel("Catatan tambahan di penawaran")).toBeVisible();
    await expectNoSideScroll(page, "sales quote");
  });
});
