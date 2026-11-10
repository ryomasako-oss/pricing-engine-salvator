import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { mapPurchaseLines } from "./mapping";
import { PURCHASES, RECEIPTS, costKind, costLines, docStep, type ReceiptConfig } from "./receipts";
import { applyPurchaseCosts } from "./purchaseCost";
import { fakeAccurate } from "./testing";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}
const creds = { token: "aat.test", signatureSecret: "secret" };
const cfg: ReceiptConfig = { pageSize: 5, everyHours: 6, since: "01/01/2026" };

/** One PI with "Total termasuk pajak" ticked, one without (Ryoma, 9 Nov: ticked → ÷ 1,11). */
const PIS = [
  { id: 801, number: "PI.2026.10.00010", transDate: "10/10/2026", lastUpdate: "10/10/2026 09:00:00", status: "OUTSTANDING", inclusiveTax: true,
    detailItem: [{ id: 1, itemNo: "A1", itemUnitName: "Pcs", quantity: 10, unitPrice: 11_100 }] },
  { id: 802, number: "PI.2026.10.00011", transDate: "11/10/2026", lastUpdate: "11/10/2026 09:00:00", status: "PAID", inclusiveTax: false,
    detailItem: [{ id: 1, itemNo: "B1", itemUnitName: "Pcs", quantity: 5, unitPrice: 20_000 }] },
];

describe("purchase invoice lines", () => {
  it("takes the line total after its item discount, ÷ 1,11 when inclusive: Accurate's DPP (PT, 9 Nov)", () => {
    // PI.2025.11.00024 line 1, as the probe returned it: 27 KTK at 85.470 incl. PPN, 10% item discount.
    const pi24 = { id: 24, number: "PI.2025.11.00024", transDate: "10/11/2025", inclusiveTax: true, subTotal: 11_275_713, cashDiscount: 0,
      detailItem: [{ id: 1, itemNo: "80801483", itemUnitName: "KTK", quantity: 27, unitPrice: 85_470, itemDiscPercent: "10", itemCashDiscount: 230_769, totalPrice: 2_076_921 }] };
    const [l] = mapPurchaseLines(pi24);
    expect(l.unitPrice).toBeCloseTo(69_300, 2);
    expect(l.unitPriceGross).toBe(85_470);
    // PI.2025.11.00046, no tax ticked: the price as is.
    const pi46 = { id: 46, number: "PI.2025.11.00046", transDate: "12/11/2025", inclusiveTax: false, subTotal: 1_807_500, cashDiscount: 0,
      detailItem: [{ id: 1, itemNo: "X", itemUnitName: "Pcs", quantity: 3, unitPrice: 65_500, totalPrice: 196_500 }] };
    expect(mapPurchaseLines(pi46)[0].unitPrice).toBe(65_500);
    // An invoice-level cash discount comes off pro rata.
    expect(mapPurchaseLines({ ...pi46, subTotal: 196_500, cashDiscount: 19_650 })[0].unitPrice).toBeCloseTo(58_950, 6);
  });

  it("divides the price by 1,11 only when the PI has 'Total termasuk pajak' ticked, keeping Accurate's price", () => {
    const [inc] = mapPurchaseLines(PIS[0]);
    expect(inc).toMatchObject({ receiptNo: "PI.2026.10.00010", itemCode: "A1", unitPriceGross: 11_100, inclusiveTax: 1 });
    expect(inc.unitPrice).toBeCloseTo(10_000, 6);
    const [exc] = mapPurchaseLines(PIS[1]);
    expect(exc).toMatchObject({ unitPrice: 20_000, unitPriceGross: 20_000, inclusiveTax: 0 });
  });

  it("syncs PIs into their own table and prices modal from them only once the source is switched to PI", async () => {
    const { sqlite, db } = freshDb();
    const f = fakeAccurate({ items: [], stock: {}, purchaseInvoices: PIS }).impl;
    for (let i = 0; i < 10; i++) {
      const r = await docStep(PURCHASES, db, "PT", creds, cfg, { budget: 10, deadline: Date.now() + 10_000, fetchImpl: f, gapMs: 0 });
      if (r.outcome === "error") throw new Error(r.error);
      if (r.outcome === "finished") break;
    }
    expect(sqlite.prepare("SELECT receipt_no, item_code, unit_price, unit_price_gross, inclusive_tax FROM accurate_purchase_lines ORDER BY receipt_id").all()).toEqual([
      { receipt_no: "PI.2026.10.00010", item_code: "A1", unit_price: 11_100 / 1.11, unit_price_gross: 11_100, inclusive_tax: 1 },
      { receipt_no: "PI.2026.10.00011", item_code: "B1", unit_price: 20_000, unit_price_gross: 20_000, inclusive_tax: 0 },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accurate_receipt_lines").get()).toEqual({ n: 0 });

    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('A1', 'Barang A', 'Pcs', 9000, 0, 0), ('B1', 'Barang B', 'Pcs', 19000, 0, 0)`);
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, units, run_id) VALUES ('PT', 1, 'A1', 'Barang A', 'Pcs', '[]', 'r'), ('PT', 2, 'B1', 'Barang B', 'Pcs', '[]', 'r')`);

    // Default (RI): the PIs are not read, nothing has a receipt.
    expect(costKind({})).toBe(RECEIPTS);
    const ri = await applyPurchaseCosts(db, "PT", { dryRun: true, lines: costLines({}) });
    expect(ri.changed).toEqual([]);

    // Switched: modal is the PI price before PPN.
    expect(costKind({ ACCURATE_COGS_SOURCE: "PI" })).toBe(PURCHASES);
    const pi = await applyPurchaseCosts(db, "PT", { dryRun: true, lines: costLines({ ACCURATE_COGS_SOURCE: "PI" }) });
    expect(pi.changed.map((c) => [c.code, Math.round(c.to), c.receiptNo])).toEqual([
      ["A1", 10_000, "PI.2026.10.00010"],
      ["B1", 20_000, "PI.2026.10.00011"],
    ]);
  });
});
