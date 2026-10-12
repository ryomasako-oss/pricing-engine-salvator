// @ts-nocheck — node:sqlite types are outside the server tsconfig, same as fixTasks.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { itemImageCode, itemImageUrl, itemFullImageUrl, itemOtherFile } from "../shared/itemImages.js";

/**
 * `itemImages` menulis lewat `./db.js`, yang membuka database dan menjalankan
 * skemanya tepat saat diimpor. Karena impor statis selalu lebih dulu dijalankan,
 * DATABASE_PATH dan IMAGES_DIR harus diarahkan ke folder sementara lebih dulu
 * baru modulnya diimpor secara dinamis — satu kali saja, di beforeAll.
 */
let tmp = "";
let imagesDir = "";
let itemImages: any;
let db: any;

const put = (name: string) => fs.writeFileSync(path.join(imagesDir, name), "gambar");
const codes = () => db.all("SELECT code FROM item_images ORDER BY code").map((r: { code: string }) => r.code);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "images-"));
  imagesDir = path.join(tmp, "images");
  fs.mkdirSync(imagesDir);
  process.env.IMAGES_DIR = imagesDir;
  process.env.DATABASE_PATH = path.join(tmp, "test.db");
  itemImages = await import("./itemImages.js");
  db = await import("./db.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IMAGES_DIR;
  delete process.env.DATABASE_PATH;
});

beforeEach(() => {
  fs.rmSync(imagesDir, { recursive: true, force: true });
  fs.mkdirSync(imagesDir);
  db.run("DELETE FROM item_images");
});

describe("nama berkas gambar", () => {
  it("kode dibaca dari berkas penuh maupun thumbnail", () => {
    expect(itemImageCode("ATK-1.webp")).toBe("ATK-1");
    expect(itemImageCode("ATK-1-thumb.webp")).toBe("ATK-1");
    expect(itemImageCode("000000001.webp")).toBe("000000001");
  });

  it("nama di luar pola ditolak", () => {
    for (const bad of ["readme.txt", "../rahasia.webp", "sub/ATK-1.webp", "a..b.webp", ".hidden.webp", "ATK 1.webp", ""]) {
      expect(itemImageCode(bad)).toBeNull();
    }
  });

  it("URL thumbnail dan gambar penuh memakai satu prefix yang sama", () => {
    const thumb = itemImageUrl("ATK-1");
    expect(thumb).toBe("/api/item-image/ATK-1-thumb.webp");
    expect(itemFullImageUrl(thumb)).toBe("/api/item-image/ATK-1.webp");
  });

  it("pasangan berkas saling menggantikan, ke dua arah", () => {
    expect(itemOtherFile("ATK-1-thumb.webp")).toBe("ATK-1.webp");
    expect(itemOtherFile("ATK-1.webp")).toBe("ATK-1-thumb.webp");
    // Kode yang memang berakhiran "-thumb" tidak boleh terpotong jadi kode lain.
    expect(itemOtherFile("ATK-thumb-thumb.webp")).toBe("ATK-thumb.webp");
    expect(itemOtherFile("bukan-gambar.txt")).toBe("bukan-gambar.txt");
  });
});

describe("daftar kode dari folder gambar", () => {
  it("folder yang belum ada berarti belum ada gambar, bukan error", () => {
    fs.rmSync(imagesDir, { recursive: true, force: true });
    expect(itemImages.scanImageCodes()).toEqual([]);
  });

  it("hanya nama berkas yang cocok polanya yang dihitung, satu kali per kode", () => {
    put("ATK-1-thumb.webp");
    put("ATK-1.webp");
    put("ATK-2.webp");
    put("catatan.txt");
    put("ATK-3.jpg");
    expect(itemImages.scanImageCodes().sort()).toEqual(["ATK-1", "ATK-2"]);
  });

  it("IMAGES_DIR menentukan folder yang dibaca", () => {
    expect(itemImages.imagesDir()).toBe(path.resolve(imagesDir));
    expect(itemImages.imageFilePath("ATK-1.webp")).toBe(path.join(path.resolve(imagesDir), "ATK-1.webp"));
  });
});

describe("sinkron ke database", () => {
  it("menulis daftar kode dan mencatat jumlahnya", async () => {
    put("ATK-1-thumb.webp");
    put("ATK-2.webp");
    expect(await itemImages.refreshItemImages()).toMatchObject({ lastError: null, images: 2 });
    expect(codes()).toEqual(["ATK-1", "ATK-2"]);
  });

  it("sinkron ulang membuang kode yang gambarnya sudah dihapus", async () => {
    put("ATK-1.webp");
    put("ATK-2.webp");
    await itemImages.refreshItemImages();
    fs.rmSync(path.join(imagesDir, "ATK-2.webp"));
    expect(await itemImages.refreshItemImages()).toMatchObject({ images: 1, lastError: null });
    expect(codes()).toEqual(["ATK-1"]);
  });

  it("status disimpan di settings dan bisa dibaca ulang", async () => {
    put("ATK-1.webp");
    await itemImages.refreshItemImages();
    expect(itemImages.getItemImagesStatus()).toMatchObject({ images: 1, lastError: null });
  });
});