/* Riwayat Audit (Ryoma 2026-11-12): plain-language labels for audit_log rows,
   shared by the page and its Excel export. Unknown entities/actions fall back
   to the raw name, so a new audit() call never breaks the page. */

import { grp } from "./format.js";

export const AUDIT_ENTITIES: Record<string, string> = {
  quote: "Quotation",
  catalog: "Katalog",
  client: "Klien",
  user: "Pengguna",
  settings: "Pengaturan",
  pending_item: "Barang baru",
  list_draft: "Draf daftar",
  fix_task: "Perlu diperbaiki",
  familiarity: "Pencocokan",
  accurate: "Accurate",
  assistant: "Silvy",
};

const ACTIONS: Record<string, string> = {
  created: "Dibuat",
  updated: "Diubah",
  edited: "Diedit",
  deleted: "Dihapus",
  restored: "Revisi dipulihkan",
  reopened: "Dibuka ulang",
  reassigned: "Dialihkan",
  revision_saved: "Revisi disimpan",
  submitted: "Diajukan",
  auto_approved: "Disetujui otomatis",
  approved: "Disetujui",
  rejected: "Ditolak",
  sales_rejected: "Harga ditolak sales",
  login: "Masuk",
  login_failed: "Gagal masuk",
  logout: "Keluar",
  password_changed: "Ganti kata sandi",
  profile_updated: "Profil diubah",
  telegram_linked: "Telegram ditautkan",
  imported: "Impor",
  cleared: "Dikosongkan",
  uom_added: "Satuan ditambah",
  image_set: "Foto dipasang",
  image_removed: "Foto dihapus",
  aliases_saved: "Alias disimpan",
  cogs_verified: "COGS diverifikasi",
  cogs_from_purchases: "COGS dari harga beli",
  accurate_applied: "Terapkan dari Accurate",
  sync_requested: "Sinkron diminta",
  reconciled: "Cek silang",
  recap_sent: "Rekap dikirim",
  policy_updated: "Kebijakan harga diubah",
  company_updated: "Data perusahaan diubah",
  excel_password_updated: "Sandi Excel diubah",
  search_priority_updated: "Prioritas pencarian diubah",
  resolved: "Diselesaikan",
  ask: "Pertanyaan",
  document: "Dokumen",
};

export const auditEntityLabel = (e: string): string => AUDIT_ENTITIES[e] ?? e;

export function auditActionLabel(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action];
  if (action.startsWith("status_")) return `Status: ${action.slice(7)}`;
  return action.replace(/_/g, " ");
}

const FIELDS: Record<string, string> = {
  cogs: "COGS",
  list_price: "Harga jual",
  name: "Nama",
  uom: "Satuan",
  category: "Kategori",
};

const show = (v: unknown): string =>
  typeof v === "number" ? grp(v)
  : Array.isArray(v) ? `${v.length} item`
  : v && typeof v === "object" ? JSON.stringify(v)
  : String(v ?? "");

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One readable line for the detail column. `before`/`after` pairs read "COGS: 10.000 → 12.000". */
export function auditDetailText(detail: string, max = 300): string {
  if (!detail) return "";
  let v: unknown;
  try {
    v = JSON.parse(detail);
  } catch {
    return clip(detail, max);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return clip(show(v), max);
  const o = v as Record<string, unknown>;
  const before = (o.before && typeof o.before === "object" ? o.before : {}) as Record<string, unknown>;
  const after = (o.after && typeof o.after === "object" ? o.after : {}) as Record<string, unknown>;
  const parts = Object.keys(after).map((k) => `${FIELDS[k] ?? k}: ${show(before[k])} → ${show(after[k])}`);
  for (const [k, val] of Object.entries(o)) {
    if (k === "before" || k === "after" || val === undefined || val === "") continue;
    parts.push(`${FIELDS[k] ?? k}: ${show(val)}`);
  }
  return clip(parts.join(" · "), max);
}

/** A WIB calendar range (YYYY-MM-DD, both days included) as audit_log's UTC text bounds [start, end). */
export function wibRangeUtc(from: string, to: string): [string, string] {
  const utc = (day: string, addDays: number) =>
    new Date(Date.parse(`${day}T00:00:00+07:00`) + addDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  return [utc(from, 0), utc(to, 1)];
}
