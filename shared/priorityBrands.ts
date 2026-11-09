/* Merek yang Silvy dahulukan saat merekomendasikan barang (Ryoma, 2026-11-09): Artline, V-TEC, GM.
   One list for the chat prompts and the catalog search order. */

export const PRIORITY_BRANDS = ["Artline", "V-TEC", "GM"] as const;

/** For the prompts: what to prefer, and that the client's own brand request still wins. */
export const PRIORITY_BRANDS_RULE =
  `Saat merekomendasikan atau mengusulkan barang, dahulukan merek ${PRIORITY_BRANDS.join(", ")} sebagai pilihan default ` +
  `bila jenis barangnya tersedia di merek itu (misalnya "spidol permanen Artline"); sebut merek lain hanya bila ketiganya tidak membuat barang itu ` +
  `atau pengguna/klien meminta merek tertentu.`;

/**
 * 1 when a catalog name is one of the priority brands, else 0, as SQL on `c.name`. GM is matched as a word
 * not right after a number, so "BOSTIK BLU TACK 75 GM" (gram) is not GM the brand but "GM ALVABOARD" is.
 */
export const PRIORITY_BRAND_SQL = `(CASE WHEN UPPER(c.name) LIKE '%ARTLINE%' OR UPPER(c.name) LIKE '%V-TEC%' OR UPPER(c.name) LIKE '%VTEC%'
  OR ((' ' || UPPER(c.name) || ' ') LIKE '% GM %' AND NOT UPPER(c.name) GLOB '*[0-9] GM*' AND NOT UPPER(c.name) GLOB '*[0-9]GM*')
  THEN 1 ELSE 0 END)`;
