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
  ask_completed: "Silvy menjawab",
  ask_failed: "Silvy gagal menjawab",
  document_completed: "Silvy membaca dokumen",
  document_failed: "Silvy gagal membaca dokumen",
  accurate_new_items: "Barang baru dari Accurate",
  cogs_held_applied: "COGS yang ditahan diterapkan",
  cogs_reset_suspect: "COGS janggal dikosongkan",
  cancelled: "Dibatalkan",
  draft_saved: "Draf disimpan",
  draft_sent: "Draf dikirim ke PIC",
  draft_done: "Draf jadi quotation",
  draft_cancelled: "Draf dibatalkan",
  feed: "Daftar klien dimasukkan",
  resolve: "Dicocokkan",
  search_index_page: "Indeks pencarian AI diperbarui",
  cleanup_junk_rows: "Baris sampah dibersihkan",
  uom_synced_from_bos: "Satuan disalin dari BOS",
  seeded: "Data awal",
};

export const auditEntityLabel = (e: string): string => AUDIT_ENTITIES[e] ?? e;

export function auditActionLabel(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action];
  if (action.startsWith("status_")) return `Status: ${action.slice(7)}`;
  return action.replace(/_/g, " ");
}

// Detail keys seen in production audit_log (2026-11-13) plus those audit() calls in server/ write; an unknown key still shows raw.
const FIELDS: Record<string, string> = {
  cogs: "COGS",
  list_price: "Harga jual",
  name: "Nama",
  uom: "Satuan",
  category: "Kategori",
  code: "Kode",
  units: "Daftar satuan",
  entity: "Perusahaan",
  number: "Nomor",
  changed: "Berubah",
  title: "Judul",
  targets: "Target",
  restart: "Ulang dari awal",
  rows: "Baris",
  silvy: "Silvy",
  recipients: "Penerima",
  date: "Tanggal",
  status: "Status",
  reservationId: "ID reservasi",
  phase: "Tahap",
  question: "Pertanyaan",
  codes: "Kode barang",
  added: "Ditambah",
  unchanged: "Tetap",
  skipped: "Dilewati",
  receiptsThrough: "Penerimaan sampai",
  noReceipt: "Tanpa penerimaan",
  source: "Sumber",
  version: "Versi",
  updated: "Diperbarui",
  inserted: "Baru",
  mode: "Mode",
  cogsFromPurchases: "COGS dari pembelian",
  from: "Dari",
  to: "Ke",
  held: "Ditahan",
  from_status: "Dari status",
  client_id: "ID klien",
  note: "Catatan",
  newItems: "Barang baru",
  feedback: "Masukan",
  count: "Jumlah",
  reason: "Alasan",
  net_margin: "Margin bersih",
  monthly_value: "Nilai bulanan",
  breaches: "Pelanggaran aturan",
  transDate: "Tanggal transaksi",
  receiptNo: "No. penerimaan",
  role: "Peran",
  email: "Email",
  created: "Dibuat",
  open: "Terbuka",
  counts: "Rincian",
  closed: "Ditutup",
  unitRows: "Baris satuan",
  unitMismatch: "Satuan tidak cocok",
  stockApplied: "Stok diterapkan",
  insertNew: "Tambah barang baru",
  quote_id: "ID quotation",
  draft_id: "ID draf",
  minNetMargin: "Margin bersih minimum",
  minLineMargin: "Margin per baris minimum",
  maxBasketDiscount: "Diskon keranjang maksimum",
  approvalValueThreshold: "Batas nilai persetujuan",
  allowBelowCost: "Boleh di bawah COGS",
  rev_no: "No. revisi",
  from_rev: "Dari revisi",
  kind: "Jenis",
  active: "Aktif",
  via: "Lewat",
  password: "Kata sandi",
  error: "Galat",
  by: "Oleh",
  phone: "Telepon",
  telegram_phone: "Telepon Telegram",
  skipped_for_manual_check: "Ditunda untuk dicek manual",
  reset_to_zero: "Dikosongkan",
  priority: "Prioritas",
  excluded: "Dikecualikan",
  deleted: "Dihapus",
  backup: "Cadangan",
  ip: "IP",
  offset: "Mulai dari",
  indexed: "Diindeks",
  next: "Berikutnya",
  removed: "Dihapus",
  tag: "Label",
  row_id: "ID baris",
  action: "Tindakan",
};

const show = (v: unknown): string =>
  typeof v === "number" ? grp(v)
  : typeof v === "boolean" ? (v ? "Ya" : "Tidak")
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
