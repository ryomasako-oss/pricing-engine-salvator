import { describe, expect, it } from "vitest";
import { codeFromFileName, codesToCheck, isSupportedCode, planRows } from "./bulkImagePlan";

const f = (name: string, type = "image/jpeg") => new File(["x"], name, { type });
const known = new Map([
  ["101885", { code: "101885", hasImage: false }],
  ["atk-1", { code: "ATK-1", hasImage: true }],
]);

describe("rencana unggah massal", () => {
  it("kode dari nama berkas: ekstensi terakhir dibuang", () => {
    expect(codeFromFileName("101885.JPG")).toBe("101885");
    expect(codeFromFileName("3M00655-06.png")).toBe("3M00655-06");
    expect(codeFromFileName("a.b.webp")).toBe("a.b");
  });

  it("kode dengan spasi atau garis miring tidak didukung", () => {
    expect(isSupportedCode("101885")).toBe(true);
    expect(isSupportedCode("4549441 009402")).toBe(false);
    expect(isSupportedCode("100115/EX")).toBe(false);
    expect(isSupportedCode("ATK-1-thumb")).toBe(false);
  });

  it("hanya gambar bernama sah yang ditanyakan ke server, tanpa pengulangan", () => {
    expect(codesToCheck([f("101885.jpg"), f("101885.png"), f("a b.jpg"), f("catatan.txt", "text/plain")])).toEqual(["101885"]);
  });

  it("menandai tiap berkas", () => {
    const rows = planRows(
      [f("101885.jpg"), f("ATK-1.png"), f("atk-1.webp"), f("TIDAK-ADA.jpg"), f("x y.jpg"), f("catatan.txt", "text/plain")],
      known,
    );
    expect(rows.map((r) => r.state)).toEqual(["ready", "overwrite", "duplicate", "unknown", "unsupported", "not-image"]);
    // Kode resmi dipakai untuk nama berkas, bukan huruf nama berkas.
    expect(rows[2].code).toBe("ATK-1");
  });
});
