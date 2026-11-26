/* Foto barang di dokumen penawaran (Ryoma, 2026-11-26): "Tampilkan foto barang di dokumen" adds a Gambar
   column with the catalog photo, on screen and in the PDF; an item without a photo is a blank cell. */

import { readFileSync } from "node:fs";
import { expect, test, THEMES } from "./helpers";

const snapshot = {
  assumptions: {
    opex: 0.08, targetMargin: 0.25, leaderMargin: 0, profitDiscount: 0, rrpDiscount: 0,
    marginFloor: 0.05, ppn: 0.11, step: 50, months: 12, includeLogistics: false,
  },
  items: [
    { id: "a", lineNo: 1, code: "SP-HTM", name: "SPIDOL WHITEBOARD SNOWMAN HITAM", uom: "Pcs", qty: 10, cogs: 5000, rrp: 8000, role: "CORE" },
    { id: "b", lineNo: 2, code: "LKB-48", name: "LAKBAN BENING 48MM", uom: "Roll", qty: 5, cogs: 9000, rrp: 13000, role: "CORE" },
  ],
  regions: [],
  meta: { quoteNo: "", date: "2026-11-26", validity: 30, payment: "", delivery: "Franco Jakarta", notes: "", paymentDays: 14, warrantyYears: 0 },
  scenario: 0,
};

/** Photos embedded in a PDF: JPEG images of the uploaded 200x200 square (the logo is a PNG with its own mask). */
const photos = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Subtype \/Image\s+\/Width 200\s+\/Height 200\s[^>]*\/DCTDecode/g) ?? []).length;

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`item photos in the quotation preview and PDF (${theme})`, async ({ page, errors }) => {
      void errors;
      await page.goto("/quotes");
      // A photo for SP-HTM only, uploaded the way the catalog does (full + thumb, WebP).
      const status = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 200;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#1d6fd8";
        ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = "#f5b400";
        ctx.fillRect(50, 50, 100, 100);
        const webp = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b!), "image/webp", 0.9));
        const form = new FormData();
        form.append("full", webp, "full.webp");
        form.append("thumb", webp, "thumb.webp");
        return (await fetch("/api/item-image/SP-HTM", { method: "POST", body: form })).status;
      });
      expect(status).toBe(200);

      const created = await page.request.post("/api/quotes", { data: { title: `E2E foto ${theme}`, snapshot } });
      const { quote } = (await created.json()) as { quote: { id: number } };
      await page.goto(`/quotes/${quote.id}`);
      await page.getByRole("button", { name: "Dokumen", exact: true }).click();
      const doc = page.locator(".quote-doc").last();
      await expect(doc.getByRole("columnheader", { name: "Gambar" })).toHaveCount(0);

      await page.getByLabel("Tampilkan foto barang di dokumen").check();
      await expect(doc.getByRole("columnheader", { name: "Gambar" })).toBeVisible();
      await expect(doc.getByRole("img", { name: "SPIDOL WHITEBOARD SNOWMAN HITAM" })).toBeVisible();
      await expect(doc.getByRole("img", { name: "LAKBAN BENING 48MM" })).toBeHidden(); // no photo: blank cell
      await doc.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/quote-photos-${theme}.png`, fullPage: true });

      await page.getByRole("button", { name: "Ekspor" }).click();
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /PDF penawaran/ }).click()]);
      const pdf = readFileSync((await download.path())!);
      await download.saveAs(`test-results/quote-photos-${theme}.pdf`);
      // SP-HTM's photo only; LKB-48 has none.
      expect(photos(pdf)).toBe(1);
    });
  });
}
