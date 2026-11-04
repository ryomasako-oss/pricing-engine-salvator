import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { mapSalesInvoice, mapSalesLines } from "./mapping";
import { normalizeText } from "../../../shared/match";
import { RECEIPT_SWEEP_EVERY_PASSES, docStep, type ReceiptConfig } from "./receipts";
import { SALES } from "./sales";
import { fakeAccurate, type FakeReceipt } from "./testing";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

const creds = { token: "aat.test", signatureSecret: "secret" };
const cfg: ReceiptConfig = { pageSize: 2, everyHours: 6, since: "01/11/2025" };
const mestika = { customerNo: "C.00030", name: "MESTIKA MAKMUR PERSADA JAYA, PT." };

type FakeInvoice = FakeReceipt & { customer: Record<string, unknown>; [k: string]: unknown };

/** SI.2026.10.00297 as the 4 Nov probe returned it (trimmed), plus others. */
const INVOICES: FakeInvoice[] = [
  { id: 95001, number: "SI.2026.10.00297", transDate: "26/10/2026", lastUpdate: "03/11/2026 12:19:06", status: "OUTSTANDING",
    approvalStatus: "APPROVED", customer: mestika, inclusiveTax: false, tax1Rate: 11, cashDiscount: 0, subTotal: 2_504_000,
    detailItem: [{ id: 146851, item: { no: "100003" }, detailName: "Spiva Mineral Water 500ML", itemUnit: { name: "BOX" }, unitRatio: 24, quantity: 16, returnQuantity: 0,
      unitPrice: 156_500, salesAmount: 2_504_000 }] },
  { id: 95002, number: "SI.2026.10.00298", transDate: "27/10/2026", lastUpdate: "27/10/2026 09:00:00", status: "OUTSTANDING",
    approvalStatus: "UNAPPROVED", customer: mestika, detailItem: [{ id: 1, item: { no: "100003" }, quantity: 1, salesAmount: 1 }] },
  { id: 90000, number: "SI.2025.06.00001", transDate: "02/06/2025", lastUpdate: "02/06/2025 08:00:00", status: "PAID",
    customer: mestika, detailItem: [{ id: 1, item: { no: "100003" }, quantity: 1, salesAmount: 9 }] },
  { id: 95003, number: "SI.2026.11.00001", transDate: "01/11/2026", lastUpdate: "01/11/2026 10:00:00", status: "PAID",
    approvalStatus: "APPROVED", customer: { customerNo: "C.00099", name: "Lain" }, inclusiveTax: true, tax1Rate: 11,
    cashDiscount: 11_100, subTotal: 111_000,
    detailItem: [
      { id: 1, itemNo: "A1", itemUnitName: "PCS", quantity: 10, salesAmount: 111_000 },
      { id: 2, itemNo: "", quantity: 1, salesAmount: 5 },
    ] },
];

async function runPass(db: D1Database, f: typeof fetch, budget = 5) {
  for (let i = 0; i < 50; i++) {
    const r = await docStep(SALES, db, "PT", creds, cfg, { budget, deadline: Date.now() + 10_000, fetchImpl: f, gapMs: 0 });
    if (r.outcome === "error") throw new Error(r.error);
    if (r.outcome === "finished") return;
  }
  throw new Error("pass did not finish");
}

describe("sales invoice mapping", () => {
  it("keeps the money fields as Accurate sends them, with the customer and the unit ratio", () => {
    expect(mapSalesLines(INVOICES[0] as unknown as Record<string, unknown>)).toEqual([{
      invoiceId: 95001, lineId: 146851, invoiceNo: "SI.2026.10.00297", transDate: "2026-10-26", customerNo: "C.00030",
      customerName: "MESTIKA MAKMUR PERSADA JAYA, PT.", itemCode: "100003", detailName: "Spiva Mineral Water 500ML",
      nameKey: normalizeText("Spiva Mineral Water 500ML"), unit: "BOX", unitRatio: 24, quantity: 16,
      returnQty: 0, salesAmount: 2_504_000, inclusiveTax: 0, taxRate: 11, cashDiscount: 0, subTotal: 2_504_000,
    }]);
  });

  it("skips an invoice whose status or approval says it never billed", () => {
    expect(mapSalesInvoice({ id: 1, status: "OUTSTANDING", approvalStatus: "UNAPPROVED" })?.received).toBe(false);
    expect(mapSalesInvoice({ id: 1, status: "PAID", approvalStatus: "APPROVED" })?.received).toBe(true);
    expect(mapSalesInvoice({ id: 1, status: "OUTSTANDING" })?.received).toBe(true);
  });
});

describe("sales invoice sync (docStep with SALES)", () => {
  it("reads approved invoices of the window over small ticks; drafts, older ones and lines without a code stay out", async () => {
    const { sqlite, db } = freshDb();
    const fake = fakeAccurate({ items: [], stock: {}, salesInvoices: INVOICES });
    await runPass(db, fake.impl, 3);
    expect(sqlite.prepare("SELECT detail_name, name_key FROM accurate_sales_lines WHERE invoice_id = 95001").get()).toEqual({
      detail_name: "Spiva Mineral Water 500ML", name_key: normalizeText("Spiva Mineral Water 500ML"),
    });
    expect(sqlite.prepare("SELECT invoice_no, item_code, customer_no, unit_ratio, inclusive_tax FROM accurate_sales_lines ORDER BY invoice_id").all()).toEqual([
      { invoice_no: "SI.2026.10.00297", item_code: "100003", customer_no: "C.00030", unit_ratio: 24, inclusive_tax: 0 },
      { invoice_no: "SI.2026.11.00001", item_code: "A1", customer_no: "C.00099", unit_ratio: 1, inclusive_tax: 1 },
    ]);
    // The draft is listed but never opened.
    expect(fake.log.filter((l) => l.includes("sales-invoice/detail.do"))).toHaveLength(2);
    // Receipts keep their own cursor.
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accurate_receipt_state").get()).toEqual({ n: 0 });
  });

  it("drops the lines of an invoice Accurate no longer lists (the sweep)", async () => {
    const { sqlite, db } = freshDb();
    await runPass(db, fakeAccurate({ items: [], stock: {}, salesInvoices: INVOICES }).impl);
    sqlite.exec(`UPDATE accurate_sales_state SET passes_since_sweep = ${RECEIPT_SWEEP_EVERY_PASSES}`);
    const left = INVOICES.filter((x) => x.id !== 95003);
    await docStep(SALES, db, "PT", creds, cfg, { budget: 20, deadline: Date.now() + 10_000, fetchImpl: fakeAccurate({ items: [], stock: {}, salesInvoices: left }).impl, gapMs: 0 });
    expect(sqlite.prepare("SELECT DISTINCT invoice_no FROM accurate_sales_lines").all()).toEqual([{ invoice_no: "SI.2026.10.00297" }]);
  });
});
