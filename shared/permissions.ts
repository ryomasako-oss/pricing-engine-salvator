/* ============================================================
   Named permissions — the single source of truth for what each role
   may do, imported by the Worker's auth (server/worker/auth.ts) and by
   the web client's AuthContext, so both agree on access.
   ============================================================ */

import type { Role } from "./types.js";

export type Permission =
  | "manage_users"
  | "manage_policy"
  | "manage_company"
  | "import_catalog"
  | "edit_catalog"
  | "delete_catalog"
  | "delete_clients"
  | "decide_quotes"
  | "edit_all_quotes"
  | "delete_quotes"
  | "view_audit"
  /** See COGS, landed cost and margin, and set them (PE-1, meeting 2026-10-05 #4). */
  | "view_costs"
  /** Create a quote from a client's list with some matches still unconfirmed, and fix them in the editor. */
  | "skip_match_review"
  /** Admin Gudang: catalog fixes (edit, units, barcodes) are saved as drafts, not applied. */
  | "draft_catalog"
  /** ACC or reject those drafts (Draf Perbaikan Divisi Gudang). Admin only (owner, 2026-11-19). */
  | "review_catalog_drafts";

/** Reproduces today's rank-based access exactly: admin inherits manager. */
const MANAGER_PERMISSIONS: Permission[] = [
  "import_catalog",
  "edit_catalog",
  "delete_clients",
  "decide_quotes",
  "edit_all_quotes",
  "view_audit",
  "view_costs",
  "skip_match_review",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  rep: [],
  gudang: ["draft_catalog"],
  manager: MANAGER_PERMISSIONS,
  admin: [
    ...MANAGER_PERMISSIONS,
    "manage_users",
    "manage_policy",
    "manage_company",
    "delete_catalog",
    "delete_quotes",
    "review_catalog_drafts",
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Every role that carries the given permission, e.g. for "who else could take over". */
export function rolesWith(permission: Permission): Role[] {
  return (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((role) => hasPermission(role, permission));
}

/** Stok pembanding / stok mandiri (pemilik, 2026-11-25): sementara hanya Admin dan Admin Gudang, bukan fitur umum. */
export const canUseStockBook = (role: Role) => hasPermission(role, "review_catalog_drafts") || hasPermission(role, "draft_catalog");
