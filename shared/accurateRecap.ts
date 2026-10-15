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
    skipped: number;
    noReceipt: number;
    /** Largest relative changes first, at most TOP_N. */
    topChanges: RecapChange[];
    topSkipped: RecapSkip[];
  };
  checks: { key: CheckKey; label: string; count: number; notify: boolean }[];
}

const jump = (c: { from: number; to: number }) => (c.from > 0 ? (c.to - c.from) / c.from : Infinity);

export function buildRecap(input: {
  now: Date;
  entity: string;
  receipts: AccurateRecap["receipts"];
  preview: { withReceipt: number; changed: RecapChange[]; unchanged: number; skipped: RecapSkip[]; noReceipt: number } | null;
  counts: ReconcileCounts | null;
}): AccurateRecap {
  const p = input.preview;
  const changed = p?.changed ?? [];
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
      skipped: p?.skipped.length ?? 0,
      noReceipt: p?.noReceipt ?? 0,
      topChanges: byJump.slice(0, TOP_N).map(({ code, name, from, to, receiptNo, transDate }) => ({ code, name, from, to, receiptNo, transDate })),
      topSkipped: (p?.skipped ?? []).slice(0, TOP_N).map(({ code, name, detail }) => ({ code, name, detail })),
    },
    checks: input.counts
      ? CHECK_KEYS.map((key) => ({ key, label: CHECKS[key].label, count: input.counts![key], notify: CHECKS[key].notify }))
      : [],
  };
}

/** Nothing for a manager to act on: no email that day. */
export const recapIsEmpty = (r: AccurateRecap) =>
  r.cogs.changed === 0 && r.cogs.skipped === 0 && !r.checks.some((c) => c.notify && c.count > 0) && !r.receipts.inProgress;

const grp = (n: number) => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const rp = (n: number) => `Rp ${grp(n)}`;
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
    `Dilewati karena satuan: ${grp(r.cogs.skipped)}`,
    `Tanpa RI (COGS tetap): ${grp(r.cogs.noReceipt)}`,
  ];
  if (r.cogs.topChanges.length) {
    lines.push("Perubahan COGS terbesar:");
    for (const c of r.cogs.topChanges.slice(0, PROMPT_CHANGES))
      lines.push(`- ${c.code} ${c.name}: ${c.from > 0 ? rp(c.from) : "kosong"} -> ${rp(c.to)} (${pctText(c)}), ${c.receiptNo} ${c.transDate}`);
  }
  if (r.cogs.topSkipped.length) {
    lines.push("Dilewati karena satuan:");
    for (const s of r.cogs.topSkipped.slice(0, PROMPT_SKIPS)) lines.push(`- ${s.code} ${s.name}: ${s.detail}`);
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
    `Rekap Accurate ${r.date}: ${grp(r.cogs.changed)} COGS berubah` +
    (r.cogs.bigJumps ? `, ${grp(r.cogs.bigJumps)} lonjakan >50%` : "") +
    (r.cogs.skipped ? `, ${grp(r.cogs.skipped)} dilewati` : "");
  const parts: string[] = [];
  parts.push(
    narrative
      ? `<div><p><small>Ringkasan singkat dari Silvy</small></p>${narrativeHtml(narrative)}</div>`
      : `<p><small>Silvy tidak bisa dihubungi pagi ini; angka di bawah tetap lengkap.</small></p>`,
  );
  if (r.receipts.inProgress) {
    parts.push(`<p><strong>Riwayat penerimaan barang masih dikumpulkan</strong> (${grp(r.receipts.receiptsSeen)} RI terbaca). Angka COGS belum lengkap.</p>`);
  }
  parts.push(
    `<h3>COGS dari harga pembelian terakhir</h3><ul>` +
      `<li>${grp(r.cogs.changed)} akan berubah jika diterapkan (naik ${grp(r.cogs.up)}, turun ${grp(r.cogs.down)}; ${grp(r.cogs.bigJumps)} berubah lebih dari 50%)</li>` +
      `<li>${grp(r.cogs.unchanged)} sudah sama</li>` +
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
  if (r.cogs.topSkipped.length) {
    parts.push(
      `<h3>Dilewati karena satuan (${grp(r.cogs.skipped)})</h3><ul>` +
        r.cogs.topSkipped.map((s) => `<li><strong>${esc(s.code)}</strong> ${esc(s.name)}<br><small>${esc(s.detail)}</small></li>`).join("") +
        `</ul>`,
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
