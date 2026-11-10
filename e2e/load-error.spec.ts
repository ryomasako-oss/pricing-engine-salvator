/* A page whose data fails to load says so and offers one retry (components/LoadError.tsx),
   instead of an empty page with only a toast. The retry must really load the data: the
   callback pages (Klien) and the effect pages that retry through a counter (Riwayat COGS). */

import { expect, test } from "./helpers";

test.use({ theme: "light" });

test("Klien: load error, then Coba lagi shows the clients", async ({ page }) => {
  let fail = true;
  await page.route("**/api/clients", (r) =>
    fail ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Server sedang sibuk."}' }) : r.continue(),
  );
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Gagal memuat data" })).toBeVisible();
  // No stale or zero count beside the error.
  await expect(page.getByText(/^\d+ klien$/)).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByText(/^\d+ klien$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gagal memuat data" })).toHaveCount(0);
});

test("Riwayat COGS: Coba lagi re-runs the request", async ({ page }) => {
  // Fails until switched off (dev StrictMode runs the mount effect twice).
  let fail = true;
  await page.route("**/api/accurate/cogs-history*", (r) => {
    return fail
      ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Server sedang sibuk."}' })
      : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, page: 1, pageSize: 20, cards: [
          { code: "ZQ-1", name: "ZQ Barang uji", uom: "Pcs", cogs: 1000, pending: null, receipts: [], changes: [] },
        ] }) });
  });
  await page.goto("/cogs-history");
  await expect(page.getByRole("heading", { name: "Gagal memuat data" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByRole("heading", { name: "ZQ Barang uji" })).toBeVisible();
  await expect(page.getByText("1 barang", { exact: true })).toBeVisible();
});
