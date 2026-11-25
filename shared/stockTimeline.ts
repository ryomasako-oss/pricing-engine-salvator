/* Riwayat stok per barang per gudang (2026-11-25): dari stok Accurate terakhir (salinan sinkron) saldo dihitung
   mundur lewat riwayat mutasi yang tersimpan (stock_mutations), lalu hasil cycle count disisipkan sebagai titik
   pembanding. Tanda: titik saldo pertama kali minus, transaksi bertanggal mundur, selisih hitung vs saldo. */

export interface TimelineMutation {
  id: number; type: string; number: string; trans_date: string | null; created_wib: string | null; qty: number; removed: boolean;
}
export interface TimelineCount { id: number; counted: number; accurate_qty: number | null; counted_wib: string; status: string; counted_by_name: string | null }

export type TimelineEvent =
  | { kind: "mutation"; at: string; m: TimelineMutation; balance: number; wentNegative: boolean; backdated: boolean }
  | { kind: "count"; at: string; c: TimelineCount; balance: number | null; gap: number | null };

/** Saldo sesudah tiap mutasi (urut waktu dibuat), dihitung mundur dari `current` = stok Accurate saat `asOfWib`.
 *  Mutasi yang dibuat sesudah `asOfWib` belum ada di angka `current`, jadi dihitung maju. Mutasi yang dihapus di
 *  Accurate tidak ikut menghitung saldo. Hasil: terbaru dulu. */
export function buildTimeline(current: number, asOfWib: string | null, mutations: TimelineMutation[], counts: TimelineCount[]): TimelineEvent[] {
  const live = mutations.filter((m) => !m.removed && m.created_wib).sort((a, b) => (a.created_wib! < b.created_wib! ? -1 : a.created_wib! > b.created_wib! ? 1 : a.id - b.id));
  const cut = asOfWib ?? "9999";
  const before = live.filter((m) => m.created_wib! <= cut);
  const after = live.filter((m) => m.created_wib! > cut);
  // Saldo sesudah mutasi terakhir yang sudah masuk angka `current` = current; mundur dari situ.
  const balances = new Map<number, number>();
  let b = current;
  for (let i = before.length - 1; i >= 0; i--) {
    balances.set(before[i].id, b);
    b -= before[i].qty;
  }
  const start = b; // saldo sebelum mutasi tertua yang tersimpan
  b = current;
  for (const m of after) balances.set(m.id, (b += m.qty));
  const ordered = [...before, ...after];
  const events: TimelineEvent[] = [];
  let prev = start;
  for (const m of ordered) {
    const bal = balances.get(m.id)!;
    events.push({
      kind: "mutation", at: m.created_wib!, m, balance: bal,
      wentNegative: bal < 0 && prev >= 0,
      backdated: !!m.trans_date && m.trans_date < m.created_wib!.slice(0, 10),
    });
    prev = bal;
  }
  for (const c of counts) {
    // Saldo menurut riwayat pada saat dihitung = saldo sesudah mutasi terakhir sebelum waktu hitung.
    const lastBefore = [...ordered].reverse().find((m) => m.created_wib! <= c.counted_wib);
    // Tanpa mutasi tersimpan: saldo = stok sekarang. Hitungan lebih tua dari riwayat tersimpan: tidak diketahui.
    const bal = lastBefore ? balances.get(lastBefore.id)! : ordered.length ? null : current;
    events.push({ kind: "count", at: c.counted_wib, c, balance: bal, gap: bal == null ? null : c.counted - bal });
  }
  return events.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.kind === "count" ? -1 : 1));
}
