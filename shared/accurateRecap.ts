/* Rekap Accurate pagi (Ryoma, 2026-10-15): COGS dari harga pembelian
   terakhir, barang yang dilewati, cek silang katalog vs Accurate, dan status
   sinkron. Worker menghitung rekapnya (server/worker/accurateRecap.ts), Silvy
   menulis ringkasan + prioritas tindakan (agent-service /silvy/report), dan
   email ke manajer memuat keduanya: narasi Silvy di atas, tabel dari sistem di
   bawah, sehingga angka di tabel tidak pernah berasal dari model.

   Keputusan Ryoma 2026-10-15: nama barang dan COGS boleh dikirim ke Gemini
   untuk laporan ini, dan promptnya harus hemat: satu panggilan per hari, tidak
   ada panggilan bila tidak ada yang perlu ditindak, dan blok DATA untuk Silvy
   hanya memuat PROMPT_CHANGES/PROMPT_SKIPS baris teratas plus cek silang yang
   tidak nol (~400-600 token masuk). Tabel lengkap di email dibuat sistem. */

import { CHECKS, CHECK_KEYS, type CheckKey, type ReconcileCounts } from "./accurateReconcile.js";

/** Rows in the email tables. */
export const TOP_N = 20;
/** Rows Silvy reads: enough to name priorities, small enough to keep each daily call cheap. */
export const PROMPT_CHANGES = 5;
export const PROMPT_SKIPS = 3;
/** Silvy writes a brief summary (Ryoma: "brief summary aja"), ~60 words; this caps a runaway reply. */
export const RECAP_MAX_OUTPUT_TOKENS = 300;
/** Same threshold as the catalog's COGS check (cogsCheck) and the apply-cogs panel. */
export const BIG_JUMP = 0.5;

export interface RecapChange {
  code: string;
  name: string;
  from: number;
  to: number;
  receiptNo: string;
  transDate: string;
}

/** A change "Terapkan" won't write (purchaseCostHold), with the reason. */
export interface RecapHold extends RecapChange {
  reason: string;
}

export interface RecapSkip {
  code: string;
  name: string;
  detail: string;
}

export interface AccurateRecap {
  /** Report day, YYYY-MM-DD in WIB. */
  date: string;
  entity: string;
  receipts: { lastPassAt: string | null; inProgress: boolean; receiptsSeen: number };
  cogs: {
    withReceipt: number;
    changed: number;
    up: number;
    down: number;
    /** Changes of more than BIG_JUMP either way, or from an empty COGS. */
    bigJumps: number;
    unchanged: number;
    /** Held back by the guard: the catalog keeps its COGS until the RI or the COGS is fixed. */
    held: number;
    skipped: number;
    noReceipt: number;
    /** Largest relative changes first, at most TOP_N. */
    topChanges: RecapChange[];
    topSkipped: RecapSkip[];
    topHeld: RecapHold[];
  };
  checks: { key: CheckKey; label: string; count: number; notify: boolean }[];
  /**
   * Items added to the catalog on their own (server/worker/accurate/newItems.ts) in the last
   * day. They start with COGS 0: one with a receipt gets it through "Terapkan COGS", one
   * without needs it by hand. Absent from an app older than this field.
   */
  newItems?: { added: number; withReceipt: number; held: number; top: RecapNewItem[] };
  /**
   * The 5-minute item/stock sync, from its one state row. `stuck`: it reports an error, or no run
   * has finished for SYNC_STUCK_HOURS. Absent when the sync was never set up.
   */
  sync?: { lastSuccessAt: string | null; lastError: string | null; stuck: boolean };
  /**
   * Catalog stock as sales see it, refreshed from Accurate after every completed run
   * (server/worker/accurate/stock.ts). Absent until the first refresh, and from an older app.
   */
  stock?: RecapStock;
}

/** Items listed under "stok minus" in the email; Silvy reads the first PROMPT_SKIPS. */
export const STOCK_TOP = 10;

export interface RecapStock {
  /** The Accurate run the stock comes from (ISO). */
  asOf: string;
  inStock: number;
  empty: number;
  negative: number;
  /** Most negative first, at most STOCK_TOP. */
  topNegative: { code: string; name: string; qty: number }[];
}

/** A run finishes every 6 hours (ACCURATE_SYNC_EVERY_HOURS); a day without one means it is stuck. */
export const SYNC_STUCK_HOURS = 24;

export interface RecapNewItem {
  code: string;
  name: string;
  /** Latest purchase price waiting in the preview (0: no receipt, COGS by hand). */
  cost: number;
  /** The guard holds that price back (receipts disagree): a manager ticks it in "Ditahan". */
  held: boolean;
}

/** Order of the new-items table: what needs a person first (by hand, then held), then what Terapkan will price. */
const rank = (i: RecapNewItem) => (i.cost <= 0 ? 0 : i.held ? 1 : 2);

const jump = (c: { from: number; to: number }) => (c.from > 0 ? (c.to - c.from) / c.from : Infinity);

export function buildRecap(input: {
  now: Date;
  entity: string;
  receipts: AccurateRecap["receipts"];
  preview: { withReceipt: number; changed: RecapChange[]; held?: RecapHold[]; unchanged: number; skipped: RecapSkip[]; noReceipt: number } | null;
  counts: ReconcileCounts | null;
  newItems?: { code: string; name: string }[];
  sync?: { last_success_at: string | null; last_error: string | null } | null;
  stock?: RecapStock | null;
}): AccurateRecap {
  const p = input.preview;
  const changed = p?.changed ?? [];
  const cost = new Map(changed.map((c) => [c.code, c.to]));
  const heldCost = new Map((p?.held ?? []).map((c) => [c.code, c.to]));
  const fresh = (input.newItems ?? []).map((i) => ({
    code: i.code,
    name: i.name,
    cost: cost.get(i.code) ?? heldCost.get(i.code) ?? 0,
    held: !cost.has(i.code) && heldCost.has(i.code),
  }));
  const byJump = [...changed].sort((a, b) => Math.abs(jump(b)) - Math.abs(jump(a)) || a.code.localeCompare(b.code));
  return {
    date: new Date(input.now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10),
    entity: input.entity,
    receipts: input.receipts,
    cogs: {
      withReceipt: p?.withReceipt ?? 0,
      changed: changed.length,
      up: changed.filter((c) => c.to > c.from).length,
      down: changed.filter((c) => c.to < c.from).length,
      bigJumps: changed.filter((c) => Math.abs(jump(c)) > BIG_JUMP).length,
      unchanged: p?.unchanged ?? 0,
      held: p?.held?.length ?? 0,
      skipped: p?.skipped.length ?? 0,
      noReceipt: p?.noReceipt ?? 0,
      topChanges: byJump.slice(0, TOP_N).map(({ code, name, from, to, receiptNo, transDate }) => ({ code, name, from, to, receiptNo, transDate })),
      topSkipped: (p?.skipped ?? []).slice(0, TOP_N).map(({ code, name, detail }) => ({ code, name, detail })),
      topHeld: (p?.held ?? []).slice(0, TOP_N).map(({ code, name, from, to, receiptNo, transDate, reason }) => ({ code, name, from, to, receiptNo, transDate, reason })),
    },
    checks: input.counts
      ? CHECK_KEYS.map((key) => ({ key, label: CHECKS[key].label, count: input.counts![key], notify: CHECKS[key].notify }))
      : [],
    newItems: {
      added: fresh.length,
      withReceipt: fresh.filter((i) => i.cost > 0 && !i.held).length,
      held: fresh.filter((i) => i.held).length,
      // Those still needing a COGS by hand first: they are the ones nothing else will fix.
      top: [...fresh].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code)).slice(0, TOP_N),
    },
    ...(input.sync
      ? {
          sync: {
            lastSuccessAt: input.sync.last_success_at,
            lastError: input.sync.last_error,
            stuck:
              !!input.sync.last_error ||
              !input.sync.last_success_at ||
              input.now.getTime() - Date.parse(input.sync.last_success_at) > SYNC_STUCK_HOURS * 3_600_000,
          },
        }
      : {}),
    ...(input.stock ? { stock: input.stock } : {}),
  };
}

/** Nothing for a manager to act on: no email that day. */
export const recapIsEmpty = (r: AccurateRecap) =>
  r.cogs.changed === 0 && r.cogs.held === 0 && r.cogs.skipped === 0 && !r.newItems?.added && !r.checks.some((c) => c.notify && c.count > 0) && !r.receipts.inProgress && !r.sync?.stuck;

const grp = (n: number) => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const rp = (n: number) => `Rp ${grp(n)}`;
/** "2026-10-30T01:00:00Z" → "30/10/2026 08:00": managers read the recap in WIB. */
const fmtWib = (iso: string) => {
  const d = new Date(Date.parse(iso) + 7 * 3_600_000).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 16)}`;
};
const pctText = (c: RecapChange) => {
  const j = jump(c);
  return Number.isFinite(j) ? `${j > 0 ? "+" : ""}${(j * 100).toFixed(1).replace(".", ",")}%` : "baru";
};

/* ---------- Silvy ---------- */

export const RECAP_SYSTEM = `Kamu Silvy, asisten Pricing Engine PT Salvator Inti Pratama. Tulis ringkasan singkat untuk manajer dari blok DATA.

COGS katalog = harga pembelian terakhir di Accurate (sebelum PPN), diterapkan manajer lewat Katalog > Pratinjau > Terapkan.

Format: 2-3 kalimat teks biasa, maksimal 60 kata, tanpa daftar dan tanpa markdown. Sebut hal terpenting dan satu tindakan yang paling mendesak.
Pakai hanya angka, kode, dan nama yang tertulis di DATA; jangan menghitung angka baru. Kalau riwayat penerimaan barang masih dikumpulkan, katakan angka COGS belum lengkap.`;

/** The DATA block Silvy reads. Plain text, one fact per line. */
export function recapPrompt(r: AccurateRecap): string {
  const lines = [
    `DATA (tanggal ${r.date}, Accurate ${r.entity})`,
    `Riwayat penerimaan barang: ${r.receipts.inProgress ? `masih dikumpulkan, ${grp(r.receipts.receiptsSeen)} RI terbaca` : r.receipts.lastPassAt ? `lengkap, diperbarui ${r.receipts.lastPassAt}` : "belum ada"}`,
    `Barang dengan RI berharga: ${grp(r.cogs.withReceipt)}`,
    `COGS akan berubah jika diterapkan: ${grp(r.cogs.changed)} (naik ${grp(r.cogs.up)}, turun ${grp(r.cogs.down)}, berubah lebih dari 50%: ${grp(r.cogs.bigJumps)})`,
    `COGS sudah sama dengan pembelian terakhir: ${grp(r.cogs.unchanged)}`,
    `Ditahan, tidak ikut diterapkan (harga beli 3x harga jual atau lebih, atau lebih dari 2x / kurang dari separuh COGS; RI perlu dicek): ${grp(r.cogs.held ?? 0)}`,
    `Dilewati karena satuan: ${grp(r.cogs.skipped)}`,
    `Tanpa RI (COGS tetap): ${grp(r.cogs.noReceipt)}`,
  ];
  if (r.cogs.topChanges.length) {
    lines.push("Perubahan COGS terbesar:");
    for (const c of r.cogs.topChanges.slice(0, PROMPT_CHANGES))
      lines.push(`- ${c.code} ${c.name}: ${c.from > 0 ? rp(c.from) : "kosong"} -> ${rp(c.to)} (${pctText(c)}), ${c.receiptNo} ${c.transDate}`);
  }
  // An app older than the agent sends no held fields (agent-service renders this prompt from the app's recap).
  const topHeld = r.cogs.topHeld ?? [];
  if (topHeld.length) {
    lines.push("Ditahan:");
    for (const h of topHeld.slice(0, PROMPT_SKIPS)) lines.push(`- ${h.code} ${h.name}: ${h.reason}, ${h.receiptNo} ${h.transDate}`);
  }
  if (r.cogs.topSkipped.length) {
    lines.push("Dilewati karena satuan:");
    for (const s of r.cogs.topSkipped.slice(0, PROMPT_SKIPS)) lines.push(`- ${s.code} ${s.name}: ${s.detail}`);
  }
  if (r.newItems?.added) {
    const n = r.newItems;
    const held = n.held ?? 0;
    lines.push(`Barang baru dari Accurate masuk katalog (24 jam terakhir, COGS masih kosong): ${grp(n.added)}; punya RI (ikut Terapkan COGS): ${grp(n.withReceipt)}; ditahan (RI tidak sepakat): ${grp(held)}; tanpa RI (isi COGS manual): ${grp(n.added - n.withReceipt - held)}`);
  }
  if (r.stock) {
    const s = r.stock;
    lines.push(`Stok katalog (posisi Accurate ${fmtWib(s.asOf)} WIB): ada stok ${grp(s.inStock)}, habis ${grp(s.empty)}, minus ${grp(s.negative)}`);
    for (const n of s.topNegative.slice(0, PROMPT_SKIPS)) lines.push(`- stok minus ${n.code} ${n.name}: ${grp(n.qty)}`);
  }
  const checks = r.checks.filter((c) => c.count > 0);
  if (checks.length) {
    lines.push("Cek silang katalog vs Accurate (yang tidak nol):");
    for (const c of checks) lines.push(`- ${c.label}: ${grp(c.count)}${c.notify ? "" : " (informasi)"}`);
  }
  return lines.join("\n");
}

/* ---------- Email ---------- */

const esc = (s: string) =>
  (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Silvy's plain text as HTML: paragraphs, and "- " lines as a list. Everything escaped. */
export function narrativeHtml(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const item = /^[-*•]\s+(.*)$/.exec(line);
    if (item) list.push(item[1]);
    else {
      flush();
      out.push(`<p>${esc(line)}</p>`);
    }
  }
  flush();
  return out.join("");
}

const td = (s: string, right = false) => `<td style="padding:4px 8px;border-bottom:1px solid #ddd${right ? ";text-align:right" : ""}">${s}</td>`;
const th = (s: string, right = false) => `<th style="padding:4px 8px;border-bottom:2px solid #999;text-align:${right ? "right" : "left"}">${s}</th>`;

export function recapEmail(
  r: AccurateRecap,
  narrative: string | null,
  link: string,
): { subject: string; html: string } {
  const subject =
    (r.sync?.stuck ? "Sinkron Accurate bermasalah · " : "") +
    `Rekap Accurate ${r.date}: ${grp(r.cogs.changed)} COGS berubah` +
    (r.cogs.bigJumps ? `, ${grp(r.cogs.bigJumps)} lonjakan >50%` : "") +
    (r.cogs.held ? `, ${grp(r.cogs.held)} ditahan` : "") +
    (r.cogs.skipped ? `, ${grp(r.cogs.skipped)} dilewati` : "") +
    (r.newItems?.added ? `, ${grp(r.newItems.added)} barang baru` : "");
  const parts: string[] = [];
  parts.push(
    narrative
      ? `<div><p><small>Ringkasan singkat dari Silvy</small></p>${narrativeHtml(narrative)}</div>`
      : `<p><small>Silvy tidak bisa dihubungi pagi ini; angka di bawah tetap lengkap.</small></p>`,
  );
  if (r.sync?.stuck) {
    parts.push(
      `<p style="color:#c0392b"><strong>Sinkron barang dan stok Accurate bermasalah.</strong> ` +
        (r.sync.lastSuccessAt ? `Terakhir selesai ${esc(r.sync.lastSuccessAt.slice(0, 16).replace("T", " "))} UTC.` : "Belum pernah selesai.") +
        (r.sync.lastError ? ` Error terakhir: ${esc(r.sync.lastError)}` : "") +
        ` Barang baru, stok dan cek silang tidak diperbarui sampai ini beres. Cek panel Accurate di Katalog.</p>`,
    );
  }
  if (r.stock) {
    const s = r.stock;
    parts.push(
      `<div style="border:1px solid #2e86de;border-radius:6px;padding:8px 12px;margin:12px 0">` +
        `<h3 style="margin:4px 0">Stok Accurate</h3>` +
        `<p><small>Posisi per ${esc(fmtWib(s.asOf))} WIB, total semua gudang, seperti yang dilihat sales di Katalog.</small></p>` +
        `<p>Ada stok <strong>${grp(s.inStock)}</strong> · habis <strong>${grp(s.empty)}</strong> · ` +
        `minus <strong${s.negative ? ' style="color:#c0392b"' : ""}>${grp(s.negative)}</strong></p>` +
        (s.topNegative.length
          ? `<p><small>Stok minus (${s.topNegative.length} dari ${grp(s.negative)}): cek pencatatan stoknya di Accurate.</small></p>` +
            `<table style="border-collapse:collapse;font-size:13px"><tr>${th("Kode")}${th("Nama")}${th("Stok", true)}</tr>` +
            s.topNegative.map((n) => `<tr>${td(esc(n.code))}${td(esc(n.name))}${td(`<strong style="color:#c0392b">${grp(n.qty)}</strong>`, true)}</tr>`).join("") +
            `</table>`
          : "") +
        `</div>`,
    );
  }
  if (r.receipts.inProgress) {
    parts.push(`<p><strong>Riwayat penerimaan barang masih dikumpulkan</strong> (${grp(r.receipts.receiptsSeen)} RI terbaca). Angka COGS belum lengkap.</p>`);
  }
  parts.push(
    `<h3>COGS dari harga pembelian terakhir</h3><ul>` +
      `<li>${grp(r.cogs.changed)} akan berubah jika diterapkan (naik ${grp(r.cogs.up)}, turun ${grp(r.cogs.down)}; ${grp(r.cogs.bigJumps)} berubah lebih dari 50%)</li>` +
      `<li>${grp(r.cogs.unchanged)} sudah sama</li>` +
      (r.cogs.held ? `<li>${grp(r.cogs.held)} ditahan, tidak ikut diterapkan (lihat di bawah)</li>` : "") +
      `<li>${grp(r.cogs.skipped)} dilewati karena satuan</li>` +
      `<li>${grp(r.cogs.noReceipt)} tanpa penerimaan barang, COGS tetap</li></ul>`,
  );
  if (r.cogs.topChanges.length) {
    parts.push(
      `<p><small>Perubahan terbesar (${r.cogs.topChanges.length} dari ${grp(r.cogs.changed)})</small></p>` +
        `<table style="border-collapse:collapse;font-size:13px">` +
        `<tr>${th("Kode")}${th("Nama")}${th("COGS sekarang", true)}${th("Pembelian terakhir", true)}${th("Selisih", true)}${th("Sumber")}</tr>` +
        r.cogs.topChanges
          .map((c) => {
            const big = Math.abs(jump(c)) > BIG_JUMP;
            const pct = big ? `<strong style="color:#c0392b">${esc(pctText(c))}</strong>` : esc(pctText(c));
            return `<tr>${td(esc(c.code))}${td(esc(c.name))}${td(c.from > 0 ? esc(rp(c.from)) : "kosong", true)}${td(esc(rp(c.to)), true)}${td(pct, true)}${td(`${esc(c.receiptNo)} · ${esc(c.transDate)}`)}</tr>`;
          })
          .join("") +
        `</table>`,
    );
  }
  if (r.cogs.topHeld.length) {
    parts.push(
      `<h3>Ditahan, tidak ikut diterapkan (${grp(r.cogs.held)})</h3>` +
        `<p><small>Biasanya satu pak/box tercatat sebagai 1 PCS di RI. Betulkan RI di Accurate, atau isi COGS manual di Katalog.</small></p><ul>` +
        r.cogs.topHeld.map((h) => `<li><strong>${esc(h.code)}</strong> ${esc(h.name)}<br><small>${esc(h.reason)} · ${esc(h.receiptNo)} · ${esc(h.transDate)}</small></li>`).join("") +
        `</ul>`,
    );
  }
  if (r.cogs.topSkipped.length) {
    parts.push(
      `<h3>Dilewati karena satuan (${grp(r.cogs.skipped)})</h3><ul>` +
        r.cogs.topSkipped.map((s) => `<li><strong>${esc(s.code)}</strong> ${esc(s.name)}<br><small>${esc(s.detail)}</small></li>`).join("") +
        `</ul>`,
    );
  }
  if (r.newItems?.added) {
    const n = r.newItems;
    const manual = n.added - n.withReceipt - n.held;
    parts.push(
      `<h3>Barang baru dari Accurate (${grp(n.added)})</h3>` +
        `<p><small>Masuk katalog otomatis dalam 24 jam terakhir dengan COGS kosong, jadi masih ditahan di quotation. ` +
        `${grp(n.withReceipt)} punya penerimaan barang: COGS-nya ikut saat Terapkan COGS. ` +
        (n.held ? `${grp(n.held)} ditahan karena harga di RI-nya tidak sepakat: cek lalu centang di tabel Ditahan. ` : "") +
        `${grp(manual)} belum punya: isi COGS manual di Katalog.</small></p>` +
        `<table style="border-collapse:collapse;font-size:13px">` +
        `<tr>${th("Kode")}${th("Nama")}${th("Pembelian terakhir", true)}</tr>` +
        n.top
          .map((i) => `<tr>${td(esc(i.code))}${td(esc(i.name))}${td(i.cost > 0 ? esc(rp(i.cost)) + (i.held ? " <small>(ditahan)</small>" : "") : "<strong>isi manual</strong>", true)}</tr>`)
          .join("") +
        `</table>` +
        (n.added > n.top.length ? `<p><small>${n.top.length} dari ${grp(n.added)} ditampilkan.</small></p>` : ""),
    );
  }
  if (r.checks.length) {
    parts.push(
      `<h3>Cek silang katalog vs Accurate ${esc(r.entity)}</h3><ul>` +
        r.checks.map((c) => `<li>${esc(c.label)}: <strong>${grp(c.count)}</strong>${c.notify ? "" : " <small>(informasi)</small>"}</li>`).join("") +
        `</ul>`,
    );
  }
  parts.push(`<p><a href="${esc(link)}">Buka Katalog untuk pratinjau dan terapkan</a></p>`);
  return { subject, html: parts.join("") };
}
