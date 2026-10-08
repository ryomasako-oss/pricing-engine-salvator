import { describe, expect, it } from "vitest";
import { holdInfo } from "./holds";
import { newItemTaskDetail } from "./pendingItems";

describe("holdInfo", () => {
  it("keeps the wording of the two older reasons, and a line without a reason is a COGS hold", () => {
    expect(holdInfo(undefined)).toBe(holdInfo("cogs"));
    expect(holdInfo("cogs").badge).toBe("Ditahan");
    expect(holdInfo("cogs").flag).toBe("Ditahan: COGS perlu dicek manajer, tidak ikut total");
    expect(holdInfo("sales").badge).toBe("Menyusul");
    expect(holdInfo("sales").sheet).toBe("Ya (ditolak sales, menyusul)");
  });

  it("says a new item waits for Accurate, and tells staff nothing about costs", () => {
    const i = holdInfo("new_item");
    expect(i.badge).toBe("Menunggu Accurate");
    expect(i.staff).not.toMatch(/COGS/);
    expect(i.manager).toMatch(/Accurate/);
  });
});

describe("newItemTaskDetail", () => {
  it("names the exact code, the name and the unit so it can be created without asking around", () => {
    const d = newItemTaskDetail({ code: "BARU-0007", name: "Kursi Ergonomis", uom: "Unit", proposed_price: 2500000, note: "warna hitam", requested_by_name: "Sales Satu" });
    expect(d).toContain('kode persis BARU-0007, nama "Kursi Ergonomis", satuan Unit');
    expect(d).toContain("Rp 2.500.000");
    expect(d).toContain("warna hitam");
    expect(d).toContain("Sales Satu");
  });

  it("leaves out what wasn't given", () => {
    const d = newItemTaskDetail({ code: "X", name: "Y", uom: "Pcs", proposed_price: 0, note: "", requested_by_name: null });
    expect(d).not.toMatch(/Perkiraan|Catatan|Diminta/);
  });
});
