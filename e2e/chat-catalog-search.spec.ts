/* A catalog lookup asked in the Home chat shows the server's rows as a table.
   No Gemini key in e2e, so the /api/chat answer is stubbed with the shape the
   route returns (server/worker/routes/chat.ts); the gate itself is covered by
   server/worker/chatSearch.test.ts against the real route. */

import { THEMES, expect, expectReadable, expectTheme, test } from "./helpers";

const ANSWER = {
  reply: "Berikut barang dengan COGS sekitar 20 ribu dari katalog.",
  lines: [],
  found: {
    kind: "cogs_problem",
    total: 25,
    items: [
      { code: "K-SD70", name: "KERTAS HVS SINAR DUNIA A4 70GR", uom: "Rim", stock: 10, cogs: 19500, problem: "COGS kosong di katalog" },
      { code: "LKB-48", name: "LAKBAN BENING 48MM", uom: "Roll", stock: 0, cogs: 21000 },
    ],
  },
};

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test.use({ theme });

    test("chat shows catalog rows as a table", async ({ page, errors }) => {
      void errors;
      await page.route("**/api/chat", (r) => r.fulfill({ json: ANSWER }));
      await page.goto("/quotes");
      await expectTheme(page, theme);
      await page.getByLabel("Pesan").first().fill("carikan barang dengan average cogs di 20 ribu");
      await page.getByLabel("Pesan").first().press("Enter");

      await expect(page.getByText("2 dari 25 barang dari katalog")).toBeVisible();
      const table = page.locator(".answer table");
      await expect(table.getByRole("columnheader")).toHaveText(["Kode", "Nama", "Satuan", "Stok", "COGS", "Masalah"]);
      const cell = table.getByRole("cell", { name: "19.500" });
      await expect(cell).toBeVisible();
      await expectReadable(cell);
      await expect(table.getByRole("cell", { name: "COGS kosong di katalog" })).toBeVisible();
      await page.screenshot({ path: `test-results/chat-catalog-search-${theme}.png`, fullPage: true });
    });
  });
}
