/* Riwayat stok per barang + tab Stok minus (2026-11-25). Data Accurate tidak ada di server uji, jadi jawabannya
   ditiru (bentuk sama dengan GET /api/stock/minus dan /api/stock/item, lihat stockLedger.test.ts). */

import { expect, test } from "./helpers";
import { buildTimeline } from "../shared/stockTimeline";

const events = buildTimeline(-5, "2026-11-25 12:00:00", [
  { id: 1, type: "RI", number: "RI.2026.11.00340", trans_date: "2026-11-17", created_wib: "2026-11-17 09:00:00", qty: 12, removed: false },
  { id: 2, type: "DO", number: "DO.2026.11.00227", trans_date: "2026-11-17", created_wib: "2026-11-18 07:52:05", qty: -10, removed: false },
  { id: 3, type: "SI", number: "SI.2026.11.00201", trans_date: "2026-11-19", created_wib: "2026-11-19 10:00:00", qty: -7, removed: false },
], [{ id: 9, counted: 12, accurate_qty: 12, counted_wib: "2026-11-17 15:00:00", status: "matched", counted_by_name: "Paulina" }]);

test("Stok minus → riwayat barang: titik minus dan tanggal mundur", async ({ page, errors }) => {
  void errors;
  await page.route("**/api/stock/minus", (r) =>
    r.fulfill({ json: { items: [{ code: "80801682", name: "LEM UJI", uom: "PCS", warehouse: "Utama", qty: -5, synced_at: "2026-11-25 05:00:00" }] } }));
  await page.route("**/api/stock/item?code=80801682", (r) =>
    r.fulfill({ json: { item: { code: "80801682", name: "LEM UJI", uom: "PCS", stock: -5 }, historyFrom: "2026-11-17 09:00:00", noWarehouse: [],
      warehouses: [{ warehouse: "Utama", accurate: -5, asOf: "2026-11-25 12:00:00", events }] } }));

  await page.goto("/gudang");
  await page.getByRole("button", { name: "Stok minus" }).click();
  await expect(page.getByRole("cell", { name: /-5/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("stok-minus.png"), fullPage: true });
  await page.getByRole("link", { name: "LEM UJI" }).click();

  const utama = page.getByRole("region", { name: "Gudang Utama" });
  await expect(utama).toContainText("Accurate sekarang -5");
  await expect(utama.getByRole("row").filter({ hasText: "SI.2026.11.00201" })).toContainText("minus mulai di sini");
  await expect(utama.getByRole("row").filter({ hasText: "DO.2026.11.00227" })).toContainText("(mundur)");
  await expect(utama.getByRole("row").filter({ hasText: "Cycle count" })).toContainText("hitung 12");
  await page.screenshot({ path: test.info().outputPath("riwayat-barang.png"), fullPage: true });
});
