import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SalesOrderCreatedEventSchema,
  SalesOrderCancelledEventSchema,
  OutboundStateChangedEventSchema,
  CatalogExportResponseSchema,
  ClientExportResponseSchema,
} from "./fmsContract";

function loadFixture(filename: string) {
  const path = join(process.cwd(), "contract-fixtures", filename);
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("Integrasi PE ↔ FMS Contract Fixtures Validation (Pricing Engine)", () => {
  it("validates so-created-minimal.json against SalesOrderCreatedEventSchema", () => {
    const data = loadFixture("so-created-minimal.json");
    const result = SalesOrderCreatedEventSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates so-created-full.json against SalesOrderCreatedEventSchema", () => {
    const data = loadFixture("so-created-full.json");
    const result = SalesOrderCreatedEventSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.items.length).toBe(2);
      expect(result.data.payload.shipping.courierCode).toBe("SPX");
    }
  });

  it("validates so-cancelled.json against SalesOrderCancelledEventSchema", () => {
    const data = loadFixture("so-cancelled.json");
    const result = SalesOrderCancelledEventSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates fms-state-changed-packing.json against OutboundStateChangedEventSchema", () => {
    const data = loadFixture("fms-state-changed-packing.json");
    const result = OutboundStateChangedEventSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.newState).toBe("PACKING");
    }
  });

  it("validates fms-state-changed-handed-over.json against OutboundStateChangedEventSchema", () => {
    const data = loadFixture("fms-state-changed-handed-over.json");
    const result = OutboundStateChangedEventSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.newState).toBe("HANDED_OVER");
      expect(result.data.payload.handoverBatchId).toBe("HO-20261117-001");
    }
  });

  it("validates catalog-export-sample.json against CatalogExportResponseSchema", () => {
    const data = loadFixture("catalog-export-sample.json");
    const result = CatalogExportResponseSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates client-export-sample.json against ClientExportResponseSchema", () => {
    const data = loadFixture("client-export-sample.json");
    const result = ClientExportResponseSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
