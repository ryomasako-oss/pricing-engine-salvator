/* The real Worker for the browser tests: `wrangler dev --local` runs
   server/worker in workerd, the runtime production uses, on a local D1 in a
   throwaway directory with every migration applied.

   Everything the screens call is the real Worker. Accurate, Silvy, OCR and
   email have no secrets here, so those features are simply off. */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "../server/worker/auth";

const port = process.env.E2E_API_PORT ?? "8797";
// One fixed folder per worktree, emptied at start: Playwright kills this server
// without running stop(), and a fresh mkdtemp per run piled up ~16 MB each in
// /tmp until the tmpfs filled and D1 answered 500s.
const dir = path.join(os.tmpdir(), `pricing-e2e-${createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8)}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
const persist = ["--persist-to", dir];
// No prompt for "apply N migrations?": nobody is there to answer it.
const quiet = { stdio: "inherit" as const, env: { ...process.env, CI: "1" } };

// wrangler checks that the assets directory exists even though Vite serves the pages in these tests.
fs.mkdirSync("dist/client", { recursive: true });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", ...persist], quiet);

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const user = async (email: string, name: string, password: string, role: string) =>
  `INSERT INTO users(email, name, password_hash, role) VALUES(${lit(email)}, ${lit(name)}, ${lit(await hashPassword(password))}, ${lit(role)});`;

/** A small catalog: two lines of the test list match, the rest owe an adjustment. */
const CATALOG: [code: string, name: string, uom: string, cogs: number, price: number][] = [
  ["K-SD70", "KERTAS HVS SINAR DUNIA A4 70GR", "Rim", 40000, 55000],
  ["K-BD70", "KERTAS HVS BOLA DUNIA A4 70GR", "Rim", 41000, 56000],
  ["SP-HTM", "SPIDOL WHITEBOARD SNOWMAN HITAM", "Pcs", 5000, 8000],
  ["LKB-48", "LAKBAN BENING 48MM", "Roll", 9000, 13000],
  ["GNT-KC", "GUNTING KERTAS JOYKO KECIL", "Pcs", 7000, 11000],
];
const seed = [
  await user("admin@e2e.test", "Administrator", "e2e-admin-password", "admin"),
  // A sales rep: the workbench is for them too, without the manager's learning report.
  await user("sales@e2e.test", "Sales E2E", "e2e-sales-password", "rep"),
  `INSERT INTO clients(name, code, address, contact_name, payment_terms, delivery_terms)
   VALUES('PT Agrinesia', 'AGR', 'Jakarta', 'Procurement', '30 hari setelah invoice', 'Franco Jakarta, jadwal mingguan');`,
  ...CATALOG.map(
    ([code, name, uom, cogs, price]) =>
      `INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, source) VALUES(${lit(code)}, ${lit(name)}, ${lit(uom)}, ${cogs}, ${price}, 10, 'e2e');`,
  ),
  // Riwayat penjualan (SI): an item only e2e/sales-history.spec.ts reads, so no other spec's list or ceiling sees it.
  `INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, source) VALUES('ZQSI-1', 'ZQSI PELUMAS RANTAI', 'Btl', 9000, 12000, 10, 'e2e');`,
  `INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_no, customer_name, item_code,
     detail_name, unit, unit_ratio, quantity, sales_amount, sub_total) VALUES
   ('PT', 9001, 1, 'SI.2026.10.09001', '2026-10-20', 'C.09001', 'PT Zqsi Klien', 'ZQSI-1', 'zqsi oli rantai 800ml', 'BOX', 12, 2, 288000, 288000),
   ('PT', 9002, 1, 'SI.2026.09.09002', '2026-09-02', 'C.09001', 'PT Zqsi Klien', 'ZQSI-1', 'ZQSI PELUMAS RANTAI', 'Btl', 1, 5, 62500, 62500);`,
  // Riwayat pembelian (PI): purchase lines of the same ZQSI item, only e2e/purchase-history.spec.ts reads them.
  `INSERT INTO accurate_purchase_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity,
     unit_price, unit_price_gross, inclusive_tax) VALUES
   ('PT', 9101, 1, 'PI.2026.10.09101', '2026-10-15', 'ZQSI-1', 'Btl', 24, 9000, 9990, 1),
   ('PT', 9102, 1, 'PI.2026.08.09102', '2026-08-01', 'ZQSI-1', 'Btl', 12, 8800, 8800, 0);`,
  // Colour variants that tie on a plain "zqhl highlighter": only e2e/match-accept-all.spec.ts lists them.
  `INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, source) VALUES
   ('ZQHL-B', 'ZQHL HIGHLIGHTER BLUE', 'Pcs', 4000, 7000, 10, 'e2e'), ('ZQHL-G', 'ZQHL HIGHLIGHTER GREEN', 'Pcs', 4000, 7000, 10, 'e2e');`,
  // A unit read from the wording ("isi 12/Lusin"): the marker's catalog has LSN = 12, the glue's has none.
  // Only e2e/unit-accept-all.spec.ts lists them.
  `INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, source) VALUES
   ('ZQLS-M', 'ZQLS SPIDOL MERAH', 'PCS', 5000, 9000, 50, 'e2e'), ('ZQLS-G', 'ZQLS LEM BATANG', 'PCS', 3000, 6000, 50, 'e2e');
   INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('ZQLS-M', 'LSN', 12);`,
  // As if a completed Accurate run had refreshed the stock (server/worker/accurate/stock.ts).
  `INSERT INTO settings(key, value) VALUES('accurate_stock_as_of', '2026-10-30T01:00:00.000Z');`,
].join("\n");
const seedFile = path.join(dir, "seed.sql");
fs.writeFileSync(seedFile, seed);
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", ...persist, "--file", seedFile], quiet);

// The full suite now runs in about a minute, past the API's 600 requests/min per IP;
// the tests were failing on 429s, not on the screens. A copy of wrangler.toml with a
// higher API limit, beside it so its relative paths resolve, only for this server.
const e2eConfig = path.resolve("wrangler.e2e.toml");
const toml = fs.readFileSync(path.resolve("wrangler.toml"), "utf8");
const raised = toml.replace(/(name = "API_LIMITER"[\s\S]*?simple = \{ limit = )600/, (_, head: string) => `${head}6000`);
if (raised === toml) throw new Error("e2e/serve.ts: API_LIMITER limit = 600 not found in wrangler.toml");
// No AI or Vectorize in tests: those bindings always reach the real Cloudflare account.
const offline = raised
  .replace(/\n\[ai\]\nbinding = "AI"\n/, "\n")
  .replace(/\n\[\[vectorize\]\]\nbinding = "CATALOG_VECTORS"\nindex_name = "catalog-search"\n/, "\n")
  .replace('CATALOG_SEMANTIC_SEARCH = "true"', 'CATALOG_SEMANTIC_SEARCH = "false"');
if (/\[ai\]|\[\[vectorize\]\]/.test(offline)) throw new Error("e2e/serve.ts: AI/Vectorize binding still in the e2e config");
fs.writeFileSync(e2eConfig, offline);

const dev = spawn(
  "npx",
  [
    "wrangler", "dev", "--config", e2eConfig, "--local", "--port", port, "--inspector-port", "0", ...persist,
    "--var", "JWT_SECRET:e2e-only-secret-not-for-production-000000000000",
    "--var", "NODE_ENV:development",
    "--var", "ACCURATE_SYNC_ENABLED:false",
    "--var", "ACCURATE_RECEIPTS_ENABLED:false",
  ],
  { stdio: "inherit" },
);
const stop = () => {
  dev.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(e2eConfig, { force: true });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
dev.on("exit", (code) => process.exit(code ?? 0));
