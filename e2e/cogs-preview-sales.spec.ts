/* Katalog → COGS dari harga pembelian terakhir → Pratinjau shows each item's last
   selling price (SI) beside the new COGS, red when it last sold under it. Accurate
   isn't configured in e2e, so its three responses are stubbed in the browser; the
   server side is covered in server/worker/accurate/receipts.test.ts. */

import { THEMES, expect, expectReadable, expectTheme, test } from "./helpers";

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("the COGS preview shows the last selling price from the sales invoices", async ({ page, errors }) => {
      void errors;
      await page.route("**/api/accurate/status*", (r) =>
        r.fulfill(json({
          catalogEntity: "PT",
          entities: [{ entity: "PT", configured: true, dbAlias: null, phase: "idle", itemsSeen: 0, stockRows: 0, lastSuccessAt: "2026-11-04T01:00:00Z",
            lastError: null, lastErrorAt: null, items: 3, priced: 3, stock: 3, warehouses: 1 }],
        })),
      );
      await page.route("**/api/accurate/receipts", (r) =>
        r.fulfill(json({ entity: "PT", enabled: true, inProgress: false, receiptsSeen: 10, lastPassAt: "2026-11-04T01:00:00Z", lastError: null })),
      );
      await page.route("**/api/accurate/apply-cogs", (r) =>
        r.fulfill(json({
          dryRun: true, withReceipt: 3, unchanged: 0, skipped: [], noReceipt: 0,
          changed: [
            { code: "ZQP-1", name: "ZQP Lakban", from: 9000, to: 10000, receiptNo: "RI.2026.10.00001", transDate: "2026-10-01" },
            { code: "ZQP-2", name: "ZQP Map", from: 5000, to: 6000, receiptNo: "RI.2026.10.00002", transDate: "2026-10-02" },
          ],
          held: [
            { code: "ZQP-3", name: "ZQP Tisu", from: 7000, to: 74750, listPrice: 7500, reason: "3x lipat", receiptNo: "RI.2026.10.00003", transDate: "2026-10-03" },
          ],
          lastSales: {
            "ZQP-1": { price: 13500, invoiceNo: "SI.2026.10.00010", date: "2026-10-20", ownClient: false },
            "ZQP-3": { price: 9000, invoiceNo: "SI.2026.10.00011", date: "2026-10-21", ownClient: false },
          },
        })),
      );

      await page.goto("/catalog");
      await expectTheme(page, theme);
      await expect(page.getByRole("link", { name: "Cari riwayat SI" })).toHaveAttribute("href", "/sales-history");
      await page.getByRole("button", { name: "Pratinjau" }).click();

      const lakban = page.getByRole("row", { name: /ZQP-1/ });
      await expect(lakban).toContainText("SI.2026.10.00010");
      await expect(lakban.getByText("Rp 13.500")).not.toHaveAttribute("style", /danger/);
      await expect(lakban.getByRole("link", { name: "SI ›" })).toHaveAttribute("href", "/sales-history?q=ZQP-1");
      await expect(page.getByRole("row", { name: /ZQP-2/ }).getByRole("cell", { name: "—" })).toBeVisible();

      // Sold at 9.000, the RI says 74.750: the sale is under the would-be COGS.
      const tisu = page.getByRole("row", { name: /ZQP-3/ });
      await expect(tisu.getByText("Rp 9.000")).toHaveAttribute("style", /danger/);
      await expectReadable(tisu.getByText("Rp 9.000"));
      await page.getByRole("columnheader", { name: "Jual terakhir (SI)" }).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/cogs-preview-sales-${theme}.png`, fullPage: true });
    });
  });
}
