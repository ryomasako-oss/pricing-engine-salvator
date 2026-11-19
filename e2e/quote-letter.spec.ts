/* Fixture signature.png is a drawn squiggle, not a real signature.
   The quotation letter from the company template (Salvator Quote.xlsx, 2026-11-19):
   logo, "Kepada Yth." / "Perihal", notes, closing, letterhead at the foot, and the
   preparer's own signature, printed only once the quote is approved. */

import path from "node:path";
import { expect, test, THEMES } from "./helpers";

const snapshot = {
  assumptions: {
    opex: 0.08, targetMargin: 0.25, leaderMargin: 0, profitDiscount: 0, rrpDiscount: 0,
    marginFloor: 0.05, ppn: 0.11, step: 50, months: 12, includeLogistics: false,
  },
  items: [{ id: "it1", lineNo: 1, code: "", name: "So Klin lantai 800 ml", uom: "BTL", qty: 10, cogs: 20000, rrp: 40000, role: "CORE" }],
  regions: [],
  meta: { quoteNo: "", date: "2026-11-19", validity: 30, payment: "", delivery: "Franco Jabodetabek", notes: "", paymentDays: 14, warrantyYears: 0 },
  scenario: 0,
};

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`letter layout, signature only after approval (${theme})`, async ({ page, errors }) => {
      void errors;
      await page.request.put("/api/auth/signature", { data: { signature: "" } });
      await page.goto("/settings?bagian=ttd");
      await expect(page.getByText("Belum ada tanda tangan.")).toBeVisible();
      await page.locator("#signature-upload").setInputFiles(path.resolve(import.meta.dirname, "fixtures/signature.png"));
      const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/auth/signature"));
      await page.getByRole("button", { name: "Simpan tanda tangan" }).click();
      expect((await saved).status()).toBe(200);
      await page.screenshot({ path: `test-results/quote-letter-settings-${theme}.png`, fullPage: true });

      const created = await page.request.post("/api/quotes", { data: { title: `E2E surat ${theme}`, snapshot } });
      const { quote } = (await created.json()) as { quote: { id: number } };
      await page.goto(`/quotes/${quote.id}`);
      await page.getByRole("button", { name: "Dokumen", exact: true }).click();
      const doc = page.locator(".quote-doc").last();
      await expect(doc).toContainText("Kepada Yth.");
      await expect(doc).toContainText("Perihal: Penawaran Harga");
      await expect(doc).toContainText("Term of payment: 14 hari");
      await expect(doc).toContainText("Demikian surat penawaran ini.");
      await expect(doc.locator(".quote-foot")).toContainText("Jalan Tiang Bendera III");
      await expect(doc.locator("img.quote-logo")).toBeVisible();
      await expect(doc.locator("img.sign-image")).toHaveCount(0);

      // Within policy, submitting approves it straight away.
      const submitted = await page.request.post(`/api/quotes/${quote.id}/submit`);
      expect(((await submitted.json()) as { quote: { status: string } }).quote.status).toBe("approved");
      await page.reload();
      await page.getByRole("button", { name: "Dokumen", exact: true }).click();
      await expect(doc.locator("img.sign-image")).toBeVisible();
      await doc.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/quote-letter-${theme}.png`, fullPage: true });
    });
  });
}
