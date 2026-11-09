/* Merek yang Silvy dahulukan saat merekomendasikan barang (Ryoma, 2026-11-09): Artline, V-TEC, GM.
   One list for the chat prompts and the catalog search order. */

export const PRIORITY_BRANDS = ["Artline", "V-TEC", "GM"] as const;

/** For the prompts: what to prefer, and that the client's own brand request still wins. */
export const PRIORITY_BRANDS_RULE =
  `Saat merekomendasikan atau mengusulkan barang, dahulukan merek ${PRIORITY_BRANDS.join(", ")} sebagai pilihan default ` +
  `bila jenis barangnya tersedia di merek itu (misalnya "spidol permanen Artline"); sebut merek lain hanya bila ketiganya tidak membuat barang itu ` +
  `atau pengguna/klien meminta merek tertentu. Ejaan lain tetap merek yang sama: "vtec", "v tec", "v.tec", "vitek" = V-TEC; "artlin", "art line" = Artline; "G.M" = GM. Di search.q, tulis mereknya seperti diketik pengguna; server mencocokkan semua ejaannya.`;

/**
 * 1 when a catalog name is one of the priority brands, else 0, as SQL on `c.name`. GM is matched as a word
 * not right after a number, so "BOSTIK BLU TACK 75 GM" (gram) is not GM the brand but "GM ALVABOARD" is.
 */
export const PRIORITY_BRAND_SQL = `(CASE WHEN UPPER(c.name) LIKE '%ARTLINE%' OR UPPER(c.name) LIKE '%V-TEC%' OR UPPER(c.name) LIKE '%VTEC%'
  OR ((' ' || UPPER(c.name) || ' ') LIKE '% GM %' AND NOT UPPER(c.name) GLOB '*[0-9] GM*' AND NOT UPPER(c.name) GLOB '*[0-9]GM*')
  THEN 1 ELSE 0 END)`;

/**
 * Brand spellings a rep may type, and how each brand is written in the catalog (9 Nov: "V-TEC" 1.131 items,
 * "VTEC" 4; Artline and GM one way each). "vtec", "v tec", "v.tec", "vitek", "artlin", "art line" all count.
 */
const BRAND_TYPED: { pattern: RegExp; catalog: string[] }[] = [
  { pattern: /(^|[^A-Z0-9])V[\s.\-]*(I|E)?T(E)?[CK]H?(?![A-Z0-9])/i, catalog: ["V-TEC", "VTEC"] },
  { pattern: /(^|[^A-Z0-9])ART[\s.\-]*L(I|AI|Y)NE?(?![A-Z0-9])/i, catalog: ["ARTLINE"] },
  { pattern: /(^|[^A-Z0-9.])G\.?\s?M\.?(?![A-Z0-9])/i, catalog: ["GM"] },
];

/**
 * Splits a catalog search into a priority brand (any spelling) and the rest of the words: "spidol vtec"
 * → brand V-TEC + "spidol". GM after a number ("75 gm") stays a weight. No brand: the query as typed.
 */
export function splitBrandQuery(q: string): { catalog: string[] | null; rest: string } {
  for (const b of BRAND_TYPED) {
    const m = b.pattern.exec(q);
    if (!m) continue;
    if (b.catalog[0] === "GM" && /\d\s*$/.test(q.slice(0, m.index + m[1].length))) continue;
    const rest = (q.slice(0, m.index + m[1].length) + " " + q.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    return { catalog: b.catalog, rest };
  }
  return { catalog: null, rest: q };
}
