/* The real Worker for the browser tests: `wrangler dev --local` runs
   server/worker in workerd, the runtime production uses, on a local D1 in a
   throwaway directory with every migration applied.

   Everything the screens call is the real Worker. Accurate, Silvy, OCR and
   email have no secrets here, so those features are simply off. */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "../server/worker/auth";

const port = process.env.E2E_API_PORT ?? "8797";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-e2e-"));
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
].join("\n");
const seedFile = path.join(dir, "seed.sql");
fs.writeFileSync(seedFile, seed);
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", ...persist, "--file", seedFile], quiet);

const dev = spawn(
  "npx",
  [
    "wrangler", "dev", "--local", "--port", port, "--inspector-port", "0", ...persist,
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
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
dev.on("exit", (code) => process.exit(code ?? 0));
