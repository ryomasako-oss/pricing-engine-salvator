/* Note di dokumen penawaran (Ryoma, 2026-11-28): the automatic lines are an editable start, a rep can change,
   drop or add lines; bank and NPWP always print from Pengaturan perusahaan. Labels "Subtotal" / "Total". */

import { readFileSync } from "node:fs";
import { expect, test, THEMES } from "./helpers";

const snapshot = {
  assumptions: {
    opex: 0.08, targetMargin: 0.25, leaderMargin: 0, profitDiscount: 0, rrpDiscount: 0,
    marginFloor: 0.05, ppn: 0.11, step: 50, months: 12, includeLogistics: false,
  },
  items: [{ id: "a", lineNo: 1, code: "", name: "So Klin lantai 800 ml", uom: "BTL", qty: 10, cogs: 20000, rrp: 40000, role: "CORE" }],
  regions: [],
  meta: { quoteNo: "", date: "2026-11-28", validity: 30, payment: "", delivery: "Franco Jakarta", notes: "", paymentDays: 14, warrantyYears: 0 },
  scenario: 0,
};

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({ theme });
    test(`edit the Note lines; bank and NPWP stay (${theme})`, async ({ page, errors }) => {
      void errors;
      await page.goto("/quotes");
      const before = ((await (await page.request.get("/api/settings")).json()) as { company: Record<string, string> }).company;
      await page.request.put("/api/settings/company", { data: { ...before, bank: "BCA 123 a.n. PT Salvator", npwp: "01.234.567.8-901.000" } });
      try {
        const created = await page.request.post("/api/quotes", { data: { title: `E2E note ${theme}`, snapshot } });
        const { quote } = (await created.json()) as { quote: { id: number } };
        await page.goto(`/quotes/${quote.id}`);
        await page.getByRole("button", { name: "Dokumen", exact: true }).click();
        const notes = page.locator(".quote-doc .quote-notes").last();
        await expect(notes).toContainText("Term of payment: 14 hari.");
        await expect(page.locator(".quote-doc .quote-totals").last()).not.toContainText("per bulan");

        await page.getByLabel("Butir note 2", { exact: true }).fill("Term of payment: DP 30%, sisa 14 hari.");
        await page.getByRole("button", { name: "Hapus butir note 3" }).click(); // Pengiriman
        await page.getByRole("button", { name: "Tambah butir" }).click();
        await page.getByLabel("Butir note 5", { exact: true }).fill("Harga sudah termasuk ongkos pasang.");
        await expect(notes).toContainText("DP 30%, sisa 14 hari.");
        await expect(notes).not.toContainText("Pengiriman: Franco Jakarta.");
        await expect(notes).toContainText("Harga sudah termasuk ongkos pasang.");
        await expect(notes).toContainText("Pembayaran ke BCA 123 a.n. PT Salvator.");
        await expect(notes).toContainText("NPWP 01.234.567.8-901.000.");
        await expect(page.getByRole("textbox", { name: /Butir note/ }).filter({ hasText: "NPWP" })).toHaveCount(0);
        await notes.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/doc-notes-${theme}.png`, fullPage: true });

        const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/quotes/${quote.id}`));
        await page.getByRole("button", { name: "Simpan", exact: true }).click();
        expect((await put).status()).toBe(200);
        await page.reload();
        await page.getByRole("button", { name: "Dokumen", exact: true }).click();
        await expect(notes).toContainText("Harga sudah termasuk ongkos pasang.");

        await page.getByRole("button", { name: "Ekspor" }).click();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /PDF penawaran/ }).click()]);
        const pdf = readFileSync((await download.path())!).toString("latin1");
        for (const t of ["DP 30%, sisa 14 hari.", "Harga sudah termasuk ongkos pasang.", "NPWP 01.234.567.8-901.000.", "(Subtotal)", "(Total)"]) expect(pdf).toContain(t);
        expect(pdf).not.toContain("Pengiriman: Franco Jakarta.");
        expect(pdf).not.toContain("per bulan)");
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: "Kembalikan otomatis" }).click();
        await expect(notes).toContainText("Pengiriman: Franco Jakarta.");
      } finally {
        await page.request.put("/api/settings/company", { data: before });
      }
    });
  });
}
