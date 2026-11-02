/* One photo per catalog item: uploaded on the Katalog page, then shown on
   every quote line with that code. A wide photo is stored square on white so
   no thumbnail (table, document, PDF, Excel's fixed 30x30) crops or stretches it. */

import { THEMES, expect, test } from "./helpers";
import type { Page } from "@playwright/test";

const CODE = "ZF-01";
const NAME = "ZFOTO Stapler";

test.beforeAll(async ({ request }) => {
  const r = await request.post("/api/catalog/import", { data: { rows: [{ code: CODE, name: NAME, cogs: 20000, list_price: 30000 }], source: "e2e" } });
  expect(r.ok()).toBe(true);
});

/** A 1200x500 JPEG, red | blue | green, so a crop to the middle shows. */
async function widePhoto(page: Page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 500;
    const g = c.getContext("2d")!;
    g.fillStyle = "#d22"; g.fillRect(0, 0, 300, 500);
    g.fillStyle = "#24d"; g.fillRect(300, 0, 600, 500);
    g.fillStyle = "#2a3"; g.fillRect(900, 0, 300, 500);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  return { name: "stapler.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
}

const quoteSnapshot = {
  assumptions: {
    opex: 0.08, targetMargin: 0.05, leaderMargin: 0, profitDiscount: 0, rrpDiscount: 0.1,
    marginFloor: 0.05, ppn: 0.11, step: 50, months: 12, includeLogistics: false,
  },
  items: [
    { id: "it1", lineNo: 1, code: CODE, name: NAME, uom: "Pcs", qty: 10, cogs: 20000, rrp: 30000, role: "CORE" },
    { id: "it2", lineNo: 2, code: "", name: "Tanpa kode", uom: "Pcs", qty: 5, cogs: 1000, rrp: 2000, role: "CORE" },
  ],
  regions: [],
  meta: { quoteNo: "", date: "2026-01-01", validity: 30, payment: "", delivery: "", notes: "", paymentDays: 30, warrantyYears: 1 },
  scenario: 0,
};

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({ theme });

    test(`upload on the catalog, shown on the quote and in the PDF (${theme})`, async ({ page, errors }) => {
      void errors;
      await page.goto("/catalog");
      await page.getByLabel("Cari katalog").fill("ZFOTO");
      const row = page.getByRole("row").filter({ hasText: NAME });
      await row.locator(".photo-input").setInputFiles(await widePhoto(page));
      const thumb = row.locator(".quote-photo img");
      await expect(thumb).toBeVisible();
      await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      const [w, h] = await thumb.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
      expect(w, "stored square").toBe(h);
      await page.screenshot({ path: test.info().outputPath(`catalog-${theme}.png`) });

      // Survives a reload: it is stored, not just previewed.
      await page.reload();
      await page.getByLabel("Cari katalog").fill("ZFOTO");
      await expect(page.getByRole("row").filter({ hasText: NAME }).locator(".quote-photo img")).toBeVisible();

      const created = await page.request.post("/api/quotes", { data: { title: "E2E foto katalog", snapshot: quoteSnapshot } });
      expect(created.ok()).toBe(true);
      const { quote } = (await created.json()) as { quote: { id: number } };
      await page.goto(`/quotes/${quote.id}`);
      await page.getByRole("button", { name: "Dokumen", exact: true }).click();
      const doc = page.locator(".quote-doc");
      await expect(doc.locator(".quote-thumb")).toHaveCount(1);
      await expect(doc.getByRole("columnheader", { name: "Foto" })).toBeVisible();
      await doc.screenshot({ path: test.info().outputPath(`doc-${theme}.png`) });

      // Opening the quote must not have saved the photo into it.
      const saved = (await (await page.request.get(`/api/quotes/${quote.id}`)).json()) as { quote: { items: { image?: string }[] } };
      expect(saved.quote.items.every((it) => it.image === undefined)).toBe(true);

      await page.getByRole("button", { name: "Ekspor" }).click();
      const download = page.waitForEvent("download");
      await page.locator(".modal .list-row").filter({ hasText: "PDF penawaran" }).click();
      const pdf = await download;
      expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
      await pdf.saveAs(test.info().outputPath("quote.pdf"));
    });
  });
}

test.describe("rep", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });

  test("sees the photo but cannot change it", async ({ page, errors }) => {
    void errors;
    await page.goto("/catalog");
    await page.getByLabel("Cari katalog").fill("ZFOTO");
    const row = page.getByRole("row").filter({ hasText: NAME });
    await expect(row.locator("img.quote-thumb")).toBeVisible();
    await expect(row.locator(".photo-input")).toHaveCount(0);
  });
});
