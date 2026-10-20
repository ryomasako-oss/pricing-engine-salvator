/* The real Express backend for the browser tests, on a throwaway database.

   Everything the screens call (/auth, /catalog, /catalog/match, /clients,
   /pending-items, /familiarity) is the real server. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-e2e-"));
process.env.DATABASE_PATH = path.join(dir, "e2e.db");
process.env.PORT = process.env.E2E_API_PORT ?? "8797";
process.env.ADMIN_EMAIL = "admin@e2e.test";
process.env.ADMIN_PASSWORD = "e2e-admin-password";
process.env.NODE_ENV = "development";

const { run } = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");
const { ensureSeed } = await import("../server/seed.js");

ensureSeed();
// A sales rep: the workbench is for them too, without the manager's learning report.
run("INSERT INTO users(email, name, password_hash, role) VALUES (?, ?, ?, 'rep')", "sales@e2e.test", "Sales E2E", hashPassword("e2e-sales-password"));

/** A small catalog: two lines of the test list match, the rest owe an adjustment. */
const CATALOG: [code: string, name: string, uom: string, cogs: number, price: number][] = [
  ["K-SD70", "KERTAS HVS SINAR DUNIA A4 70GR", "Rim", 40000, 55000],
  ["K-BD70", "KERTAS HVS BOLA DUNIA A4 70GR", "Rim", 41000, 56000],
  ["SP-HTM", "SPIDOL WHITEBOARD SNOWMAN HITAM", "Pcs", 5000, 8000],
  ["LKB-48", "LAKBAN BENING 48MM", "Roll", 9000, 13000],
  ["GNT-KC", "GUNTING KERTAS JOYKO KECIL", "Pcs", 7000, 11000],
];
for (const [code, name, uom, cogs, price] of CATALOG) {
  run("INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, source) VALUES (?, ?, ?, ?, ?, 10, 'e2e')", code, name, uom, cogs, price);
}

await import("../server/index.js");
