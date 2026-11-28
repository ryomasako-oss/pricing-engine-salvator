/* Surat perubahan harga (Ryoma, 2026-11-26): analysis of one SI with a real loss, a draft letter to the
   client, and its ACC. Cost data, so view_costs throughout; deciding takes decide_quotes and follows the
   quote rule for block breaches (Pengaturan > Kebijakan harga): "other" = a manager or admin other than
   the author, "admin" = admins only. The author may still withdraw (reject) their own draft. Prices are
   recomputed from D1 on create: the client sends only the codes and the new prices. */

import { Hono } from "hono";
import { z } from "zod";
import { all, batch, get, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { zodMessage } from "../../validate";
import { currentPolicy } from "../quoteService";
import { salesBelowCostOfInvoice } from "../accurate/sales";
import { costLines } from "../accurate/receipts";
import { catalogEntity } from "../accurate/sync";
import { DEFAULT_ASSUMPTIONS } from "../../../shared/engine";
import { letterLines, newPriceRefusal, type LetterLine } from "../../../shared/priceLetter";
import type { Env } from "../env";

export const priceLettersRouter = new Hono<Env>();
priceLettersRouter.use(requireAuth, requirePermission("view_costs"));

const day = /^\d{4}-\d{2}-\d{2}$/;

/** The SI, its client, and the letter lines with suggested prices; null when the SI isn't synced. */
async function analyse(env: Env["Bindings"], invoiceNo: string) {
  const entity = catalogEntity(env);
  const head = await get<{ invoice_no: string; trans_date: string; customer_name: string; customer_no: string }>(
    env.DB,
    "SELECT invoice_no, trans_date, customer_name, customer_no FROM accurate_sales_lines WHERE entity = ? AND invoice_no = ? LIMIT 1",
    entity,
    invoiceNo,
  );
  if (!head) return null;
  const [result, policy] = await Promise.all([salesBelowCostOfInvoice(env.DB, entity, invoiceNo, costLines(env)), currentPolicy(env.DB)]);
  const rule = { minNetMargin: policy.minNetMargin, opex: DEFAULT_ASSUMPTIONS.opex, step: DEFAULT_ASSUMPTIONS.step };
  const client = await get<{ id: number; name: string; address: string; contact_name: string }>(
    env.DB,
    `SELECT id, name, address, contact_name FROM clients
      WHERE (?1 <> '' AND accurate_customer_no = ?1) OR lower(trim(name)) = lower(trim(?2))
      ORDER BY (accurate_customer_no = ?1) DESC LIMIT 1`,
    head.customer_no,
    head.customer_name,
  );
  return { head, client: client ?? null, rule, rows: result.below, lines: letterLines(result.below, rule) };
}

/** Analysis of one SI: every loss row (with its cause) and the letter lines for the real ones. */
priceLettersRouter.get("/analysis", async (c) => {
  const invoice = (c.req.query("invoice") ?? "").trim();
  if (!invoice) return c.json({ error: "Nomor SI wajib diisi." }, 400);
  const a = await analyse(c.env, invoice);
  if (!a) return c.json({ error: "SI tidak ditemukan di data Accurate yang sudah tersinkron." }, 404);
  const open = await get<{ id: number; number: string; status: string }>(
    c.env.DB, "SELECT id, number, status FROM price_letters WHERE invoice_no = ? AND status <> 'rejected'", invoice);
  return c.json({ ...a, letter: open ?? null });
});

priceLettersRouter.get("/", async (c) => {
  const items = await all(
    c.env.DB,
    `SELECT l.id, l.number, l.invoice_no, l.invoice_date, l.customer_name, l.effective_date, l.status, l.created_at,
            l.decided_at, u.name AS created_by_name, d.name AS decided_by_name,
            (SELECT COUNT(*) FROM price_letter_lines x WHERE x.letter_id = l.id) AS lines
       FROM price_letters l JOIN users u ON u.id = l.created_by LEFT JOIN users d ON d.id = l.decided_by
      ORDER BY l.id DESC LIMIT 500`,
  );
  return c.json({ items });
});

const letterSql = `SELECT l.*, u.name AS created_by_name, d.name AS decided_by_name,
                          cl.name AS client_name, cl.address AS client_address, cl.contact_name AS client_contact
                     FROM price_letters l JOIN users u ON u.id = l.created_by LEFT JOIN users d ON d.id = l.decided_by
                     LEFT JOIN clients cl ON cl.id = l.client_id
                    WHERE l.id = ?`;

priceLettersRouter.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const letter = await get(c.env.DB, letterSql, id);
  if (!letter) return c.json({ error: "Surat tidak ditemukan." }, 404);
  const lines = await all(c.env.DB, "SELECT * FROM price_letter_lines WHERE letter_id = ? ORDER BY line_no", id);
  return c.json({ letter, lines });
});

const createSchema = z.object({
  invoice_no: z.string().trim().min(1).max(60),
  effective_date: z.string().regex(day, "Tanggal berlaku tidak valid."),
  note: z.string().max(1000).default(""),
  lines: z.array(z.object({ code: z.string().min(1).max(60), new_price: z.number() })).min(1).max(200),
});

/** Next number in the SIP/SPH/YYMM/NNN series. */
async function nextNumber(d1: D1Database, date = new Date()): Promise<string> {
  const prefix = `SIP/SPH/${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, "0")}/`;
  const last = await get<{ number: string }>(
    d1, "SELECT number FROM price_letters WHERE number LIKE ? ORDER BY length(number) DESC, number DESC LIMIT 1", `${prefix}%`);
  return prefix + String((last ? Number(last.number.slice(prefix.length)) : 0) + 1).padStart(3, "0");
}

priceLettersRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { invoice_no, effective_date, note, lines } = parsed.data;
  const a = await analyse(c.env, invoice_no);
  if (!a) return c.json({ error: "SI tidak ditemukan di data Accurate yang sudah tersinkron." }, 404);
  const byCode = new Map<string, LetterLine>(a.lines.map((l) => [l.code, l]));
  if (new Set(lines.map((l) => l.code)).size !== lines.length) return c.json({ error: "Ada barang yang dobel." }, 400);
  for (const l of lines) {
    const real = byCode.get(l.code);
    if (!real) return c.json({ error: `Barang ${l.code} tidak rugi di ${invoice_no}, jadi tidak bisa masuk surat.` }, 400);
    const why = newPriceRefusal(real, l.new_price);
    if (why) return c.json({ error: why }, 400);
  }
  // Numbers can collide under concurrent creates: retry like quote numbers; the per-SI index answers 409.
  for (let attempt = 0; attempt < 5; attempt++) {
    const number = await nextNumber(c.env.DB);
    try {
      const [ins] = await batch(c.env.DB, [
        stmt(c.env.DB,
          `INSERT INTO price_letters(number, invoice_no, invoice_date, customer_name, customer_no, client_id, effective_date, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          number, invoice_no, a.head.trans_date, a.head.customer_name, a.head.customer_no, a.client?.id ?? null, effective_date, note, user.id),
        ...lines.map((l, i) => {
          const r = byCode.get(l.code)!;
          return stmt(c.env.DB,
            `INSERT INTO price_letter_lines(letter_id, line_no, code, name, unit, old_price, cost, receipt_no, suggested, new_price)
             VALUES ((SELECT id FROM price_letters WHERE number = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            number, i + 1, r.code, r.name, r.unit, r.oldPrice, r.cost, r.receiptNo, r.suggested, l.new_price);
        }),
      ]);
      const id = Number(ins.meta.last_row_id);
      await audit(c.env.DB, user.id, "price_letter", id, "created", { number, invoice_no, lines });
      return c.json({ id, number }, 201);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("price_letters.invoice_no") || msg.includes("price_letters_open_invoice"))
        return c.json({ error: `Sudah ada surat untuk ${invoice_no} yang belum ditolak.` }, 409);
      if (!msg.includes("price_letters.number")) throw e;
    }
  }
  return c.json({ error: "Nomor surat bentrok, coba lagi." }, 409);
});

const decideSchema = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).default("") });

priceLettersRouter.post("/:id{[0-9]+}/decide", requirePermission("decide_quotes"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const letter = await get<{ status: string; created_by: number }>(c.env.DB, "SELECT status, created_by FROM price_letters WHERE id = ?", id);
  if (!letter) return c.json({ error: "Surat tidak ditemukan." }, 404);
  if (letter.status !== "draft") return c.json({ error: "Surat sudah diputuskan." }, 409);
  if (parsed.data.decision === "approved") {
    const rule = (await currentPolicy(c.env.DB)).blockApprover ?? "other";
    if (rule === "admin" && user.role !== "admin") return c.json({ error: "Surat perubahan harga hanya bisa di-ACC admin." }, 403);
    if (letter.created_by === user.id) return c.json({ error: "Surat yang Anda buat harus di-ACC manajer atau admin lain." }, 403);
  }
  const [res] = await batch(c.env.DB, [
    stmt(c.env.DB,
      "UPDATE price_letters SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ? AND status = 'draft'",
      parsed.data.decision, user.id, parsed.data.note, id),
  ]);
  if (res.meta.changes === 0) return c.json({ error: "Surat sudah diputuskan." }, 409);
  await audit(c.env.DB, user.id, "price_letter", id, parsed.data.decision, { note: parsed.data.note });
  return c.json({ ok: true });
});

/** The author's signature, only on an approved letter: a draft never prints with one. */
priceLettersRouter.get("/:id{[0-9]+}/signature", async (c) => {
  const letter = await get<{ status: string; created_by: number }>(
    c.env.DB, "SELECT status, created_by FROM price_letters WHERE id = ?", Number(c.req.param("id")));
  if (!letter) return c.json({ error: "Surat tidak ditemukan." }, 404);
  const signer = await get<{ name: string; signature: string }>(c.env.DB, "SELECT name, signature FROM users WHERE id = ?", letter.created_by);
  return c.json({ name: signer?.name ?? "", signature: letter.status === "approved" ? signer?.signature ?? "" : "" });
});
