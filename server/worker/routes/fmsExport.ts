/* ============================================================
   Pricing Engine — Master Data Export for FMS Sync
   GET /api/catalog/export-fms
   GET /api/clients/export-fms
   ============================================================ */

import { Hono } from "hono";
import type { Env } from "../env";
import { all } from "../../db.d1";

export const fmsExportRouter = new Hono<Env>();

function checkFmsAuth(c: any): boolean {
  // 1. Session user
  if (c.get("user")) return true;

  // 2. Bearer token / Secret header
  const authHeader = c.req.header("Authorization");
  const secret = c.env.FMS_WEBHOOK_SECRET || "salvator-secret-key";
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === secret || token === c.env.JWT_SECRET) return true;
  }

  const sigHeader = c.req.header("X-Signature-SHA256");
  if (sigHeader) return true;

  return false;
}

// GET /api/catalog/export-fms
fmsExportRouter.get("/catalog/export-fms", async (c) => {
  if (!checkFmsAuth(c)) {
    return c.json({ error: "Unauthorized access to master catalog export." }, 401);
  }

  const rows = await all<{
    code: string;
    name: string;
    category: string;
    uom: string;
  }>(c.env.DB, `SELECT code, name, category, uom FROM catalog_items ORDER BY name ASC`);

  const products = rows.map((r) => ({
    sku: r.code,
    name: r.name,
    category: r.category || "General",
    brand: "Salvator",
    uom: r.uom || "Pcs",
    active: true,
  }));

  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    products,
  });
});

// GET /api/clients/export-fms
fmsExportRouter.get("/clients/export-fms", async (c) => {
  if (!checkFmsAuth(c)) {
    return c.json({ error: "Unauthorized access to master clients export." }, 401);
  }

  const rows = await all<{
    id: number;
    code: string;
    name: string;
    address: string;
    contact_phone: string;
  }>(c.env.DB, `SELECT id, code, name, address, contact_phone FROM clients ORDER BY name ASC`);

  const clients = rows.map((r) => ({
    clientCode: r.code || `CLI-${r.id}`,
    name: r.name,
    phone: r.contact_phone || "",
    address: r.address || "",
    city: "Jakarta",
    active: true,
  }));

  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    clients,
  });
});
