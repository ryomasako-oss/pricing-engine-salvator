import { Hono } from "hono";
import { all, get, run } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { clientSchema, zodMessage } from "../../validate";
import { sameClient } from "../../../shared/clients";
import type { Client, DocTemplate } from "../../../shared/types";
import type { Env } from "../env";

export const clientsRouter = new Hono<Env>();
clientsRouter.use(requireAuth);

type ClientRow = Omit<Client, "doc_template"> & { doc_template: string | null };

/** doc_template is stored as JSON text; the API hands out the object (null when unset or unreadable). */
function withTemplate<T extends ClientRow>(row: T): Omit<T, "doc_template"> & { doc_template: DocTemplate | null } {
  let doc_template: DocTemplate | null = null;
  try {
    doc_template = row.doc_template ? (JSON.parse(row.doc_template) as DocTemplate) : null;
  } catch {
    // A corrupt template prints the standard document rather than failing the page.
  }
  return { ...row, doc_template };
}

const readClient = async (db: D1Database, id: number) => {
  const row = await get<ClientRow>(db, "SELECT * FROM clients WHERE id = ?", id);
  return row && withTemplate(row);
};

clientsRouter.get("/", async (c) => {
  const clients = await all<ClientRow>(
    c.env.DB,
    `SELECT c.*, (SELECT COUNT(*) FROM quotes q WHERE q.client_id = c.id) AS quote_count
       FROM clients c ORDER BY c.name`,
  );
  return c.json({ clients: clients.map(withTemplate) });
});

clientsRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const parsed = clientSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const d = parsed.data;
  const existing = sameClient(d.name, await all<Client>(c.env.DB, "SELECT * FROM clients"));
  if (existing) return c.json({ error: `Klien ini sudah ada sebagai \"${existing.name}\". Pakai yang itu, atau bedakan namanya.`, existing }, 409);
  const info = await run(
    c.env.DB,
    `INSERT INTO clients(name, code, address, contact_name, contact_email, contact_phone,
                         payment_terms, delivery_terms, accurate_customer_no, doc_template)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.name, d.code, d.address, d.contact_name, d.contact_email, d.contact_phone,
    d.payment_terms, d.delivery_terms, d.accurate_customer_no,
    d.doc_template ? JSON.stringify(d.doc_template) : null,
  );
  const id = Number(info.meta.last_row_id);
  await audit(c.env.DB, user.id, "client", id, "created", { name: d.name });
  return c.json({ client: await readClient(c.env.DB, id) }, 201);
});

clientsRouter.put("/:id", async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = clientSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const before = await get<{ doc_template: string | null }>(c.env.DB, "SELECT doc_template FROM clients WHERE id = ?", id);
  if (!before) {
    return c.json({ error: "Klien tidak ditemukan." }, 404);
  }
  const d = parsed.data;
  const existing = sameClient(d.name, await all<Client>(c.env.DB, "SELECT * FROM clients"), id);
  if (existing) return c.json({ error: `Klien ini sudah ada sebagai \"${existing.name}\". Pakai yang itu, atau bedakan namanya.`, existing }, 409);
  // A caller that does not send doc_template (older forms, scripts) keeps the stored one.
  const template = d.doc_template === undefined ? before.doc_template : d.doc_template && JSON.stringify(d.doc_template);
  await run(
    c.env.DB,
    `UPDATE clients SET name = ?, code = ?, address = ?, contact_name = ?, contact_email = ?,
            contact_phone = ?, payment_terms = ?, delivery_terms = ?, accurate_customer_no = ?, doc_template = ? WHERE id = ?`,
    d.name, d.code, d.address, d.contact_name, d.contact_email, d.contact_phone,
    d.payment_terms, d.delivery_terms, d.accurate_customer_no, template, id,
  );
  await audit(c.env.DB, user.id, "client", id, "updated", {
    name: d.name,
    ...(template !== before.doc_template ? { doc_template: template ? "diubah" : "dihapus" } : {}),
  });
  return c.json({ client: await readClient(c.env.DB, id) });
});

clientsRouter.delete("/:id", requirePermission("delete_clients"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const used = await get<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM quotes WHERE client_id = ?", id);
  if (used && used.n > 0) {
    return c.json(
      { error: `Klien ini masih dipakai ${used.n} quotation. Hapus atau pindahkan quotation itu dulu.` },
      409,
    );
  }
  await run(c.env.DB, "DELETE FROM clients WHERE id = ?", id);
  await audit(c.env.DB, user.id, "client", id, "deleted");
  return c.json({ ok: true });
});
