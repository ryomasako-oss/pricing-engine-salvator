import { describe, expect, it } from "vitest";
import { lineFromCatalog, matchLines, normalizeText, similarity, splitPackText, tokens } from "./match";
import type { CatalogItem } from "./types";

const item = (id: number, code: string, name: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  code,
  name,
  uom: "Pcs",
  cogs: 1000,
  list_price: 1500,
  stock: 0,
  category: "",
  source: "",
  updated_at: "",
  ...over,
});

const CATALOG = [
  item(1, "100036", "STABILO BOSS HIGHLIGHTER ANTI DRY OUT ORANGE"),
  item(2, "100037", "STABILO BOSS HIGHLIGHTER ANTI DRY OUT GREEN"),
  item(3, "K-BD70", "BOLA DUNIA KERTAS A4 70GR"),
  item(4, "K-SD80", "SINAR DUNIA KERTAS A4 80GR"),
  item(5, "778", "FORMULA SIKAT GIGI"),
  item(6, "EK70B", "ARTLINE EK-70 PERMANENT MARKER BLUE"),
  item(7, "EK70LB", "ARTLINE EK-70 PERMANENT MARKER LT. BLUE"),
  item(8, "PST", "STANDARD PULPEN TECNO BLACK 0.38MM"),
];
const none = { client: new Map<string, string>(), global: new Map<string, string>() };

describe("normalizeText / tokens", () => {
  it("glues units to numbers and unifies gram spellings", () => {
    expect(normalizeText("Kertas A4 70 gsm")).toBe("kertas a4 70g");
    expect(normalizeText("Kertas 70gr")).toBe("kertas 70g");
    expect(normalizeText("Tinta 100 ML")).toBe("tinta 100ml");
  });
  it("maps synonyms and drops filler words", () => {
    expect(tokens("Pena warna hitam")).toEqual(["pulpen", "hitam"]);
    expect(tokens("Ballpoint black")).toEqual(["pulpen", "hitam"]);
  });
  it("keeps decimals but not trailing dots", () => {
    expect(tokens("Pulpen 0,5 mm.")).toEqual(["pulpen", "0.5mm"]);
  });
  it("splits a dot that is not between two digits (No.10, Uk.F4)", () => {
    expect(normalizeText("Isi Staples Kenko No.10")).toBe("isi staples kenko no 10");
    expect(normalizeText("Map Uk.F4")).toBe("map uk f4");
    expect(normalizeText("Pulpen 0.5mm")).toBe("pulpen 0.5mm");
  });
  it("matches a client's \"no 10\" to the catalog's \"No.10\", not to another size-10 item", () => {
    const catalog = [item(10, "ST10", "ISI STAPLES KENKO NO.10"), item(11, "HD10", "STAPLER KENKO HD-10")];
    const [r] = matchLines([{ name: "Isi staples no 10", qty: 1 }], catalog, none);
    expect(r.candidates[0].id).toBe(10);
  });
});

describe("similarity", () => {
  it("is 1 for identical names and 0 for nothing in common", () => {
    expect(similarity(tokens("Formula sikat gigi"), tokens("FORMULA SIKAT GIGI"))).toBe(1);
    expect(similarity(tokens("lakban"), tokens("FORMULA SIKAT GIGI"))).toBe(0);
  });
  it("penalises a size the item lacks (70g vs 80g paper)", () => {
    const want = tokens("Kertas A4 70gsm Sinar Dunia");
    expect(similarity(want, tokens("SINAR DUNIA KERTAS A4 80GR"))).toBeLessThan(0.6);
  });
  it("is 0 for empty input", () => {
    expect(similarity([], tokens("abc"))).toBe(0);
    expect(similarity(tokens("abc"), [])).toBe(0);
  });
});

describe("matchLines", () => {
  it("matches by code first, case and spaces ignored, when the name agrees or names only the code", () => {
    const [named] = matchLines([{ code: " k-bd70 ", name: CATALOG[2].name.toLowerCase() }], CATALOG, none);
    expect(named).toMatchObject({ status: "exact", via: "code", candidates: [{ id: 3, score: 1 }] });
    const [bare] = matchLines([{ code: "K-BD70", name: "K-BD70" }], CATALOG, none);
    expect(bare).toMatchObject({ status: "exact", via: "code" });
    const [empty] = matchLines([{ code: "K-BD70", name: "" }], CATALOG, none);
    expect(empty).toMatchObject({ status: "exact", via: "code" });
  });

  it("ignores a client's own code that hits a different item (CGV 100591 garam vs our 100591 sealant, 2026-10-17)", () => {
    const [r] = matchLines([{ code: " k-bd70 ", name: "something unrelated" }], CATALOG, none);
    expect(r.via).not.toBe("code");
    expect(r.status).not.toBe("exact");
    // The line is then matched by its name like any other.
    const [byName] = matchLines([{ code: "k-bd70", name: "Stabilo boss highlighter orange" }], CATALOG, none);
    expect(byName).toMatchObject({ status: "match", via: "name" });
    expect(byName.candidates[0].id).toBe(1);
  });

  it("auto-matches a strong, unambiguous, complete name match", () => {
    const [r] = matchLines([{ name: "Stabilo boss highlighter orange" }], CATALOG, none);
    expect(r.status).toBe("match");
    expect(r.candidates[0].id).toBe(1);
  });

  // Regression: "Sinar Dunia" was auto-matched to "BOLA DUNIA" (score 0.857)
  // on the real catalog before the every-word rule.
  it("does not auto-accept when a client word (the brand) is missing from the item", () => {
    const [r] = matchLines([{ name: "Kertas A4 70gsm Sinar Dunia" }], CATALOG, none);
    expect(r.candidates[0].id).toBe(3);
    expect(r.status).toBe("review");
  });

  it("asks for review when the runner-up is too close (blue vs light blue)", () => {
    const [r] = matchLines([{ name: "Spidol permanen Artline 70 biru" }], CATALOG, none);
    expect(r.status).toBe("review");
    expect(r.candidates.map((c) => c.id).slice(0, 2)).toEqual([6, 7]);
  });

  it("returns none when nothing is close", () => {
    const [r] = matchLines([{ name: "Galon air mineral" }], CATALOG, none);
    expect(r.status).toBe("none");
    expect(r.via).toBeNull();
  });

  it("uses a learned alias, client-specific over global", () => {
    const aliases = {
      client: new Map([[normalizeText("Kertas fotokopi"), "K-SD80"]]),
      global: new Map([[normalizeText("Kertas fotokopi"), "K-BD70"]]),
    };
    const [r] = matchLines([{ name: "kertas  FOTOKOPI" }], CATALOG, aliases);
    expect(r).toMatchObject({ status: "exact", via: "alias" });
    expect(r.candidates[0]).toEqual({ id: 4, score: 1 });
    // The alias target isn't repeated among the alternatives.
    expect(r.candidates.filter((c) => c.id === 4)).toHaveLength(1);

    const [g] = matchLines([{ name: "Kertas fotokopi" }], CATALOG, { client: new Map(), global: aliases.global });
    expect(g.candidates[0].id).toBe(3);
  });

  it("ignores an alias whose code is no longer in the catalog", () => {
    const aliases = { client: new Map([["formula sikat gigi", "GONE"]]), global: new Map<string, string>() };
    const [r] = matchLines([{ name: "Formula sikat gigi" }], CATALOG, aliases);
    expect(r).toMatchObject({ status: "match", via: "name" });
  });

  it("keeps the input order and index", () => {
    const rs = matchLines([{ name: "sikat gigi formula" }, { name: "zzz" }], CATALOG, none);
    expect(rs.map((r) => r.index)).toEqual([0, 1]);
  });
});

describe("lineFromCatalog", () => {
  const boxed = item(9, "PB", "PULPEN BOX", {
    cogs: 2000,
    list_price: 3000,
    units: [{ uom: "Box", factor: 12 }],
  });

  it("uses catalog COGS and list price in the base unit", () => {
    const line = lineFromCatalog(boxed, 5);
    expect(line).toMatchObject({ code: "PB", uom: "Pcs", qty: 5, cogs: 2000, rrp: 3000, role: "CORE", estCogs: false });
  });

  it("converts to the requested unit with the item's ratio", () => {
    const line = lineFromCatalog(boxed, 2, { uom: "box" });
    expect(line).toMatchObject({ uom: "Box", cogs: 24000, rrp: 36000 });
    expect(line.priceUom).toBeUndefined();
  });

  it("applies a client-stated ceiling after conversion (it is per the requested unit)", () => {
    const line = lineFromCatalog(boxed, 2, { uom: "Box", rrp: 30000 });
    expect(line).toMatchObject({ uom: "Box", cogs: 24000, rrp: 30000 });
  });

  it("flags an unknown unit instead of converting wrongly", () => {
    const line = lineFromCatalog(boxed, 1, { uom: "Lusin" });
    expect(line).toMatchObject({ uom: "Lusin", cogs: 2000, priceUom: "Pcs" });
  });

  it("treats a same-unit request with different case as the base unit", () => {
    expect(lineFromCatalog(boxed, 1, { uom: "PCS" })).toMatchObject({ uom: "Pcs", cogs: 2000 });
  });

  // Regression: for staff the catalog row has no `cogs` (PE-1); an item with
  // no list price then got rrp NaN, sent as null, and the quote was refused.
  it("never produces NaN when the row has no COGS (staff) and no list price", () => {
    const staffRow = { ...item(11, "Y", "Y", { list_price: 0 }), cogs: undefined } as unknown as CatalogItem;
    const line = lineFromCatalog(staffRow, 2);
    expect(line).toMatchObject({ cogs: 0, rrp: 0, estCogs: true });
    expect(JSON.parse(JSON.stringify(line)).rrp).toBe(0);
  });

  it("marks COGS as estimated when the catalog has none", () => {
    const line = lineFromCatalog(item(10, "X", "X", { cogs: 0, list_price: 500 }), 1);
    expect(line).toMatchObject({ cogs: 0, rrp: 500, estCogs: true });
  });
});

describe("lineFromCatalog records the catalog COGS it copied", () => {
  it("in the line's unit, and not when the catalog has no COGS", () => {
    const pen = item(20, "P-1", "Pulpen", { cogs: 1000, units: [{ uom: "Box", factor: 12 }] });
    expect(lineFromCatalog(pen, 1).catalogCogs).toBe(1000);
    expect(lineFromCatalog(pen, 1, { uom: "Box" }).catalogCogs).toBe(12000);
    expect(lineFromCatalog(item(21, "P-2", "Kosong", { cogs: 0 }), 1).catalogCogs).toBeUndefined();
  });
});

/** Nama katalog sungguhan dari PO PT Primajaya (2026-11-02): 30 baris, 11 jatuh ke "none" padahal barangnya ada. */
describe("PO klien: kemasan di kurung, nomor part, istilah Indonesia", () => {
  const PO_CATALOG = [
    item(100034, "100034", "JOYKO BINDER CLIP NO.105"),
    item(100644, "100644", "JOYKO BINDER CLIP NO.107"),
    item(100381, "100381", "JOYKO BINDER CLIP NO.155"),
    item(100646, "100646", "JOYKO BINDER CLIP NO.200"),
    item(103379, "103379", "JOYKO BINDER CLIP NO.280"),
    item(100382, "100382", "JOYKO BINDER CLIP NO.300"),
    item(80801930, "80801930", "JOYKO TRIGONAL CLIP NO.1"),
    item(5000, "ATK-0005", "JOYKO Trigonal Clip No.1 (isi 10 ktk)"),
    item(100225, "100225", "JOYKO CORRECTION TAPE CT-522"),
    item(102654, "102654", "JOYKO CT-595 CORRECTION TAPE"),
    item(80800915, "80800915", "DELKO CLOTH TAPE 24MM X 12M BLACK"),
    item(101885, "101885", "JOYKO GLUE STICK GS-25 GR"),
    item(101551, "101551", "JOYKO STAMP PAD NO.2"),
    item(101552, "101552", "JOYKO STAMP PAD NO.0"),
    item(100851, "100851", "JOYKO STAMP PAD INK SPI-12 BLUE"),
    item(100852, "100852", "JOYKO STAMP PAD INK SPI-12 RED"),
  ];
  const run = (name: string, code?: string) => matchLines([{ name, code }], PO_CATALOG)[0];

  it("memisahkan kemasan di kurung dari nama barang", () => {
    expect(splitPackText("Binder Clip Joyko No. 105 (1 Gross @12 Pack)")).toEqual({ core: "Binder Clip Joyko No. 105  ", pack: "(1 Gross @12 Pack)" });
    expect(splitPackText("Artline EK-660 Hijau ( isi 12/Lusin )").pack).toBe("( isi 12/Lusin )");
    expect(splitPackText("Bantalan Stempel Joyko No. 2 (15.8 cm x 10.4 cm)").pack).toBe("(15.8 cm x 10.4 cm)");
    // Detail barang di kurung tetap.
    for (const keep of ["Stamp Pad Ink SPI-12 (Blue)", "Pelubang Kertas (Besar)", "Correction Pen Re-Type (Tipe X Set)"]) {
      expect(splitPackText(keep)).toEqual({ core: keep, pack: "" });
    }
  });

  it("kemasan tidak lagi menghukum: binder clip PO cocok otomatis ke nomornya", () => {
    const lines = [
      ["Binder Clip Joyko No. 105 (1 Gross @12 Pack)", 100034],
      ["Binder Clip Joyko No. 107 (1 Gross @12 Pack)", 100644],
      ["Binder Clip Joyko No.155 (1 Gross @12 Pack)", 100381],
      ["Binder Clip Joyko No.200 (1 Gross @12 Pack)", 100646],
      ["Binder Clip Joyko No.280 (1 box @6 PCS)", 103379],
      ["Binder Clip Joyko No. 300 (1 box @6 PCS)", 100382],
    ] as const;
    for (const [name, id] of lines) {
      const r = run(name);
      expect(r.status).toBe("match");
      expect(r.candidates[0].id).toBe(id);
    }
  });

  it("nomor yang berbeda tidak tertukar walau kemasannya sama", () => {
    expect(run("Binder Clip Joyko No. 105 (1 Gross @12 Pack)").candidates[0].id).not.toBe(100644);
  });

  it("kemasan membantu barang yang menyebutnya, dan menang atas barang kembar yang tidak", () => {
    expect(run("JOYKO Trigonal Clip No.1 (isi 10 ktk)").candidates[0].id).toBe(5000);
    expect(run("JOYKO Trigonal Clip No.1").candidates[0].id).toBe(80801930);
  });

  it("detail barang di kurung tetap membedakan (Blue vs Red)", () => {
    expect(run("Tinta Stamp Pad Ink Joyko SPI-12 (Blue)").candidates[0].id).toBe(100851);
    expect(run("Tinta Stamp Pad Ink Joyko SPI-12 (Red)").candidates[0].id).toBe(100852);
  });

  it("glue stick dengan teks kemasan tidak jatuh ke none", () => {
    const r = run("Joyko Glue Stick GS-25 isi 25 gram ( isi 12/lusin)");
    expect(r.status).not.toBe("none");
    expect(r.candidates[0].id).toBe(101885);
  });

  it("nomor part yang tercetak di PO dan ada di nama katalog mengangkat barangnya, hanya sampai review", () => {
    const withPart = run("Correction Tape Joyko 12M", "CT-522");
    expect(withPart.candidates[0].id).toBe(100225);
    expect(withPart.status).toBe("review");
    // Nomor yang tidak ada di mana pun, atau terlalu pendek/tanpa angka, tidak mengubah apa-apa.
    expect(run("Correction Tape Joyko 12M", "XYZ-999")).toEqual(run("Correction Tape Joyko 12M"));
    expect(run("Correction Tape Joyko 12M", "CT")).toEqual(run("Correction Tape Joyko 12M"));
  });

  it("nomor part tidak mengangkat barang yang namanya sama sekali beda", () => {
    const r = run("Lakban Bening 2 inch", "CT-522");
    expect(r.candidates.map((c) => c.id)).not.toContain(100225);
  });

  it("Bantalan Stempel = Stamp Pad, dan ukuran di kurung tidak menggugurkan", () => {
    const r = run("Bantalan Stempel Besar Joyko No. 2 (15.8 cm x 10.4 cm)");
    expect(r.status).toBe("review");
    expect(r.candidates[0].id).toBe(101551);
  });
});

describe("lebar dalam inci dibaca juga sebagai milimeter", () => {
  const TAPES = [
    item(102324, "102324", 'NACHI ISOLASI HITAM (3/4") 19MM X 20 METER'),
    item(101637, "101637", "NACHI CLOTH TAPE HITAM 72MM x 12M"),
    item(100890, "100890", 'DAIMARU LAKBAN BENING 2"'),
    item(101553, "101553", 'DAIMARU LAKBAN HITAM 2"'),
    item(9001, "9001", "DAIMARU LAKBAN COKLAT 2 INCH"),
    item(9002, "9002", 'DAIMARU LAKBAN BENING 3"'),
  ];
  const top = (name: string) => matchLines([{ name }], TAPES)[0];

  it("tanda inci menghasilkan angka inci dan ukuran mm-nya sebagai pilihan; pecahan jadi satu token", () => {
    expect(tokens('Lakban 3"')).toContain("3|72mm");
    expect(tokens("Lakban 2 inch")).toContain("2|48mm");
    expect(tokens('Isolasi (3/4") 19MM')).toEqual(expect.arrayContaining(["3/4|19mm", "19mm"]));
    expect(tokens('Isolasi (3/4") 19MM')).not.toContain("3");
    // Ukuran inci yang tidak lazim untuk lakban tetap angka biasa.
    expect(tokens('Bracket TV 65"')).toContain("65");
    // Kunci alias memakai normalizeText, yang tidak berubah.
    expect(normalizeText('Lakban 3"')).toBe("lakban 3");
  });

  it('Nachi Lakban Hitam 3" menuju kain 72MM, bukan isolasi 3/4"', () => {
    expect(top('Nachi Lakban Hitam 3"').candidates[0].id).toBe(101637);
  });

  it('pecahan 3/4" tidak ikut cocok dengan lebar 3"', () => {
    expect(top('Nachi Isolasi Hitam 3/4"').candidates[0].id).toBe(102324);
  });

  it("inci, mm, dan tulisan inch saling menemukan", () => {
    expect(top("Lakban Daimaru Bening 48mm").candidates[0].id).toBe(100890);
    expect(top("Lakban Daimaru Bening 2 inch").candidates[0].id).toBe(100890);
    expect(top('Lakban Daimaru Bening 3"').candidates[0].id).toBe(9002);
  });

  it('cara lama tetap jalan: 2" cocok dengan "2 INCH" di nama katalog dan lebar lain tidak tertukar', () => {
    expect(top('Lakban Daimaru Coklat 2"').candidates[0].id).toBe(9001);
    expect(top('Lakban Daimaru Hitam 2"')).toMatchObject({ status: "match" });
    expect(top('Lakban Daimaru Hitam 2"').candidates[0].id).toBe(101553);
    expect(top('Lakban Daimaru Bening 2"').candidates[0].id).toBe(100890);
  });
});

