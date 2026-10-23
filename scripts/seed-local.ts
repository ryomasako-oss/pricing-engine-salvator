/* ============================================================
   Local development database, once: `npm run d1:seed:local`, then
   `npm run dev`.

   - applies every migration to the local D1 (.wrangler/state), as
     production has them;
   - writes .dev.vars with a random JWT_SECRET if there is none
     (git-ignored; wrangler dev reads it);
   - on an empty database, creates the first admin and a sample client,
     as the old Express seed did. ADMIN_EMAIL / ADMIN_PASSWORD /
     ADMIN_NAME choose the account; without a password one is generated
     and printed once.
   ============================================================ */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "../server/worker/auth";

const quiet = { stdio: "inherit" as const, env: { ...process.env, CI: "1" } };
const d1 = (...args: string[]) => execFileSync("npx", ["wrangler", "d1", ...args, "--local"], { ...quiet, stdio: "pipe" }).toString();

execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"], quiet);

if (!fs.existsSync(".dev.vars")) {
  fs.writeFileSync(".dev.vars", `JWT_SECRET=${randomBytes(32).toString("base64url")}\nNODE_ENV=development\n`);
  console.log("Wrote .dev.vars (JWT_SECRET for local development only).");
}

const users = JSON.parse(d1("execute", "DB", "--json", "--command", "SELECT COUNT(*) AS n FROM users"))[0].results[0].n as number;
if (users > 0) {
  console.log(`Local database already has ${users} user(s); nothing seeded.`);
  process.exit(0);
}

const email = (process.env.ADMIN_EMAIL || "admin@salvator.co.id").toLowerCase();
const name = process.env.ADMIN_NAME || "Administrator";
const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString("base64url");
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pricing-seed-")), "seed.sql");
fs.writeFileSync(
  file,
  `INSERT INTO users(email, name, password_hash, role) VALUES(${lit(email)}, ${lit(name)}, ${lit(await hashPassword(password))}, 'admin');
INSERT INTO clients(name, code, address, contact_name, payment_terms, delivery_terms)
  SELECT 'PT Agrinesia', 'AGR', 'Jakarta', 'Procurement', '30 hari setelah invoice', 'Franco Jakarta, jadwal mingguan'
  WHERE NOT EXISTS (SELECT 1 FROM clients);
`,
);
d1("execute", "DB", "--file", file);
fs.rmSync(path.dirname(file), { recursive: true, force: true });

console.log("\n  ==============================================");
console.log("   Akun administrator lokal dibuat");
console.log(`   Email     : ${email}`);
console.log(`   Kata sandi: ${password}`);
if (!process.env.ADMIN_PASSWORD) console.log("   (dibuat acak — simpan sekarang, tidak ditampilkan lagi)");
console.log("  ==============================================\n");
