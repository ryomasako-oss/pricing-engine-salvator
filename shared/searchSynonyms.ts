/* Padanan kata untuk cari barang di chat (Ryoma, 2026-11-09): sales mengetik "spidol permanen", katalog
   menulis "PERMANENT MARKER" (9 Nov, PT: SPIDOL 11 nama vs MARKER 658, PERMANEN 2 vs PERMANENT 130).
   Groups are built from words that appear in catalog names; each typed word also matches its group. */

const GROUPS: string[][] = [
  ["SPIDOL", "MARKER"],
  ["PULPEN", "PENA", "PEN", "BALLPOINT", "BOLPOIN"],
  ["PENSIL", "PENCIL"],
  ["LEM", "GLUE", "ADHESIVE"],
  ["ISOLASI", "SELOTIP", "LAKBAN", "TAPE"],
  ["PENGHAPUS", "ERASER"],
  ["PENGGARIS", "RULER", "MISTAR"],
  ["GUNTING", "SCISSORS", "SCISSOR"],
  ["STAPLER", "STAPLES", "HEKTER", "STEPLES"],
  ["MAP", "FOLDER", "FILE", "ORDNER", "ODNER"],
  ["KERTAS", "PAPER"],
  ["BUKU", "BOOK", "NOTEBOOK"],
  ["AMPLOP", "ENVELOPE"],
  ["TINTA", "INK"],
  ["BATERAI", "BATTERY"],
  ["KUAS", "BRUSH"],
  ["CAT", "PAINT"],
  ["STIKER", "STICKER"],
  ["STABILO", "HIGHLIGHTER"],
  ["KOREKSI", "CORRECTION", "TIPEX", "TIP-EX"],
  ["PERMANEN", "PERMANENT"],
  ["KLIP", "CLIP"],
  ["TISU", "TISSUE"],
  ["SABUN", "SOAP"],
  ["SAPU", "BROOM"],
  ["PEL", "MOP"],
  ["MASKER", "MASK"],
  ["KALKULATOR", "CALCULATOR"],
  ["CUTTER", "PISAU", "KNIFE"],
  ["STEMPEL", "STAMP"],
  ["KURSI", "CHAIR"],
  ["MEJA", "DESK"],
  ["LAMPU", "LAMP"],
  ["KABEL", "CABLE"],
  ["SEKAT", "DIVIDER"],
  ["SARUNG", "GLOVE", "GLOVES"],
  // Warna (catalog names mix both: "HITAM" and "BLACK", "MERAH" and "RED").
  ["HITAM", "BLACK"],
  ["MERAH", "RED"],
  ["BIRU", "BLUE"],
  ["HIJAU", "GREEN"],
  ["KUNING", "YELLOW"],
  ["PUTIH", "WHITE"],
  ["UNGU", "PURPLE", "VIOLET"],
  ["COKLAT", "COKELAT", "BROWN"],
  ["ABU", "GREY", "GRAY"],
  ["ORANYE", "ORANGE", "JINGGA"],
  ["BENING", "TRANSPARAN", "CLEAR", "TRANSPARENT"],
];

const BY_WORD = new Map<string, string[]>();
for (const g of GROUPS) for (const w of g) BY_WORD.set(w, g);

/** Up to this length a synonym must be a whole word: "PEN" must not find PENSIL, "CAT" not CATYLAC. */
const WHOLE_WORD_MAX = 4;

export interface WordMatch {
  /** Substrings of the name or code, as before (the word as typed). */
  typed: string;
  /** Other words of its group, matched in the name: substring, or whole word when short. */
  synonyms: { word: string; whole: boolean }[];
}

/** One entry per typed word (letters or digits); search ANDs the words and ORs each word's synonyms. */
export function searchWords(q: string): WordMatch[] {
  return q
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((typed) => {
      const group = BY_WORD.get(typed.toUpperCase()) ?? [];
      return {
        typed,
        synonyms: group.filter((w) => w !== typed.toUpperCase()).map((word) => ({ word, whole: word.length <= WHOLE_WORD_MAX })),
      };
    });
}

/** The other words of a typed word's group, lowercase ("spidol" → ["marker"]); none when it has no group. */
export function synonymsOf(word: string): string[] {
  const up = (word ?? "").toUpperCase();
  return (BY_WORD.get(up) ?? []).filter((w) => w !== up).map((w) => w.toLowerCase());
}
