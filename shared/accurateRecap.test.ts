import { describe, expect, it } from "vitest";
import { PROMPT_CHANGES, PROMPT_SKIPS, TOP_N, buildRecap, narrativeHtml, recapEmail, recapIsEmpty, recapPrompt, type RecapChange } from "./accurateRecap";
import { CHECK_KEYS, type ReconcileCounts } from "./accurateReconcile";

const change = (code: string, from: number, to: number): RecapChange => ({ code, name: `Barang ${code}`, from, to, receiptNo: `RI.${code}`, transDate: "2026-05-22" });
const zeroCounts = Object.fromEntries(CHECK_KEYS.map((k) => [k, 0])) as ReconcileCounts;
const ready = { lastPassAt: "2026-10-16T02:00:00Z", inProgress: false, receiptsSeen: 4800 };

const recap = (over: Partial<Parameters<typeof buildRecap>[0]> = {}) =>
  buildRecap({
    now: new Date("2026-10-16T01:00:00Z"),
    entity: "PT",
    receipts: ready,
    preview: {
      withReceipt: 4,
      changed: [change("101311", 10_831_300, 11_005_000), change("A1", 4000, 7500), change("B2", 1000, 900), change("N0", 0, 500)],
      unchanged: 7,
      skipped: [{ code: "C1", name: "Map <Plastik>", detail: "Satuan katalog Box, satuan dasar Accurate Pcs" }],
      noReceipt: 30,
    },
    counts: { ...zeroCounts, price_below_cogs: 250, uom_diff: 100 },
    ...over,
  });

describe("buildRecap", () => {
  it("counts the changes and lists the largest jumps first, a COGS that was empty counting as the largest", () => {
    const r = recap();
    expect(r.date).toBe("2026-10-16");
    expect(r.cogs).toMatchObject({ withReceipt: 4, changed: 4, up: 3, down: 1, bigJumps: 2, unchanged: 7, skipped: 1, noReceipt: 30 });
    expect(r.cogs.topChanges.map((c) => c.code)).toEqual(["N0", "A1", "B2", "101311"]);
    expect(r.checks.find((c) => c.key === "price_below_cogs")).toMatchObject({ count: 250, notify: true });
  });

  it("keeps at most TOP_N rows per list", () => {
    const many = Array.from({ length: 50 }, (_, i) => change(`X${i}`, 100, 101 + i));
    const r = recap({ preview: { withReceipt: 50, changed: many, unchanged: 0, skipped: [], noReceipt: 0 } });
    expect(r.cogs.changed).toBe(50);
    expect(r.cogs.topChanges).toHaveLength(TOP_N);
  });

  it("is empty when there is nothing to act on, and not while receipts are still being collected", () => {
    const quiet = { preview: { withReceipt: 3, changed: [], unchanged: 3, skipped: [], noReceipt: 0 }, counts: zeroCounts };
    expect(recapIsEmpty(recap(quiet))).toBe(true);
    expect(recapIsEmpty(recap({ ...quiet, receipts: { ...ready, inProgress: true } }))).toBe(false);
    expect(recapIsEmpty(recap())).toBe(false);
  });
});

describe("recapPrompt (what Silvy reads: kept small, one call a day)", () => {
  it("sends only the top rows and the checks that aren't zero", () => {
    const many = Array.from({ length: 30 }, (_, i) => change(`X${i}`, 100, 101 + i));
    const skips = Array.from({ length: 12 }, (_, i) => ({ code: `S${i}`, name: `S${i}`, detail: "tanpa rasio" }));
    const p = recapPrompt(recap({ preview: { withReceipt: 30, changed: many, unchanged: 0, skipped: skips, noReceipt: 0 } }));
    expect(p.match(/^- X\d+ /gm)).toHaveLength(PROMPT_CHANGES);
    expect(p.match(/^- S\d+ /gm)).toHaveLength(PROMPT_SKIPS);
    expect(p).toContain("Harga jual Accurate di bawah COGS katalog: 250");
    expect(p).not.toContain("Harga jual katalog beda dengan Accurate"); // a check at 0 isn't sent
    // Roughly 4 characters per token: the whole DATA block stays well under 1,000 tokens.
    expect(p.length).toBeLessThan(4000);
  });

  it("states the numbers Silvy may use, including an unfinished history", () => {
    const p = recapPrompt(recap({ receipts: { lastPassAt: null, inProgress: true, receiptsSeen: 127 } }));
    expect(p).toContain("masih dikumpulkan, 127 RI terbaca");
    expect(p).toContain("101311 Barang 101311: Rp 10.831.300 -> Rp 11.005.000 (+1,6%), RI.101311 2026-05-22");
    expect(p).toContain("N0 Barang N0: kosong -> Rp 500 (baru)");
  });
});

describe("recapEmail", () => {
  it("puts Silvy's summary on top, escaped, with the system's tables below", () => {
    const m = recapEmail(recap(), "Dua lonjakan besar <b>hari</b> ini.\n\nPrioritas:\n- Cek A1\n- Rapikan C1\n- Cek harga jual", "https://x/catalog");
    expect(m.subject).toBe("Rekap Accurate 2026-10-16: 4 COGS berubah, 2 lonjakan >50%, 1 dilewati");
    expect(m.html).toContain("<p>Dua lonjakan besar &lt;b&gt;hari&lt;/b&gt; ini.</p>");
    expect(m.html).toContain("<ul><li>Cek A1</li><li>Rapikan C1</li><li>Cek harga jual</li></ul>");
    expect(m.html).toContain("Map &lt;Plastik&gt;");
    expect(m.html).toContain('<a href="https://x/catalog">');
    expect(m.html.indexOf("Ringkasan singkat dari Silvy")).toBeLessThan(m.html.indexOf("COGS dari harga pembelian terakhir"));
  });

  it("still carries every number when Silvy can't be reached", () => {
    const m = recapEmail(recap(), null, "https://x/catalog");
    expect(m.html).toContain("Silvy tidak bisa dihubungi");
    expect(m.html).toContain("4 akan berubah jika diterapkan");
  });

  it("narrativeHtml turns '- ' lines into a list and leaves no raw HTML", () => {
    expect(narrativeHtml("Halo\n- satu\n* dua\nAkhir <script>")).toBe("<p>Halo</p><ul><li>satu</li><li>dua</li></ul><p>Akhir &lt;script&gt;</p>");
  });
});
