import { describe, expect, it } from "vitest";
import { heldNote, holdInfo } from "./holds";
import { CANCELLED_ITEM_PROBLEM, PENDING_ITEM_PROBLEM, isAutoCode, isPendingItemProblem, newItemTaskDetail, pendingHoldReason } from "./pendingItems";

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

describe("a cancelled barang baru", () => {
  it("is held under its own reason, with no cost talk for staff", () => {
    expect(pendingHoldReason(PENDING_ITEM_PROBLEM)).toBe("new_item");
    expect(pendingHoldReason(CANCELLED_ITEM_PROBLEM)).toBe("new_item_cancelled");
    expect(pendingHoldReason("COGS kosong")).toBeNull();
    expect(isPendingItemProblem(CANCELLED_ITEM_PROBLEM)).toBe(true);
    expect(holdInfo("new_item_cancelled").badge).toBe("Dibatalkan");
    expect(holdInfo("new_item_cancelled").staff).not.toMatch(/COGS/);
  });

  it("is not promised to the customer as an item that will follow", () => {
    const rows = [
      { held: true, holdReason: "new_item" as const, name: "Kursi" },
      { held: true, holdReason: "new_item_cancelled" as const, name: "Meja batal" },
    ];
    expect(heldNote(rows)).toBe("1 item menyusul, harganya sedang dikonfirmasi: Kursi.");
  });
});

describe("isAutoCode", () => {
  it("knows the numbering's own codes, however typed", () => {
    expect(isAutoCode("BARU-0007")).toBe(true);
    expect(isAutoCode(" baru-12 ")).toBe(true);
    expect(isAutoCode("BARU-A1")).toBe(false);
    expect(isAutoCode("ACC-BARU-1")).toBe(false);
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
