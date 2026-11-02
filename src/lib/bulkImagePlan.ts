import { itemImageCode } from "@shared/itemImages";

export type BulkState = "ready" | "overwrite" | "unknown" | "unsupported" | "not-image" | "duplicate";

export interface BulkRow {
  file: File;
  /** Kode dari nama berkas (tanpa ekstensi). */
  name: string;
  /** Kode resmi di katalog, bila ada. */
  code: string | null;
  state: BulkState;
}

export const BULK_STATE_LABEL: Record<BulkState, string> = {
  ready: "Baru",
  overwrite: "Timpa gambar lama",
  unknown: "Kode tidak ada di katalog",
  unsupported: "Kode memuat spasi atau karakter yang belum didukung",
  "not-image": "Bukan gambar",
  duplicate: "Ganda, berkas ini dilewati",
};

/** Kode dari nama berkas: ekstensi terakhir dibuang. "101885.JPG" -> "101885". */
export const codeFromFileName = (fileName: string): string => fileName.replace(/\.[^./\\]+$/, "").trim();

/** Kode yang sah sebagai nama berkas gambar (lihat shared/itemImages.ts). */
export const isSupportedCode = (code: string): boolean => itemImageCode(`${code}.webp`) === code;

/** Kode yang perlu ditanyakan ke server: gambar dengan nama yang sah saja. */
export function codesToCheck(files: Pick<File, "name" | "type">[]): string[] {
  const codes = files
    .filter((f) => f.type.startsWith("image/"))
    .map((f) => codeFromFileName(f.name))
    .filter(isSupportedCode);
  return [...new Set(codes)];
}

/** Keadaan tiap berkas. `known` = jawaban server per kode dari nama berkas (huruf besar-kecil
 *  tidak dibedakan, sama seperti katalog). Berkas kedua dengan kode yang sama dilewati. */
export function planRows(files: File[], known: Map<string, { code: string; hasImage: boolean }>): BulkRow[] {
  const seen = new Set<string>();
  return files.map((file): BulkRow => {
    const name = codeFromFileName(file.name);
    const row = (state: BulkState, code: string | null = null): BulkRow => ({ file, name, code, state });
    if (!file.type.startsWith("image/")) return row("not-image");
    if (!isSupportedCode(name)) return row("unsupported");
    const hit = known.get(name.toLowerCase());
    if (!hit) return row("unknown");
    if (seen.has(hit.code)) return row("duplicate", hit.code);
    seen.add(hit.code);
    return row(hit.hasImage ? "overwrite" : "ready", hit.code);
  });
}
