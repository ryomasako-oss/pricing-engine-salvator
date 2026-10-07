/* PE-2 on the quote page: importing the "Cek harga" file sales filled in,
   and what the last check said. The file is read here in the browser
   (src/export/salesReview.ts); only ids, decisions and reasons go to the
   server, which checks them against the quote as it is now. */

import { useState } from "react";
import { api } from "../api";
import { fmtDateTime } from "@shared/format";
import type { StoredReviewLine } from "@shared/salesReview";
import type { Quote } from "@shared/types";
import type { ReadReview } from "../export/salesReview";
import { Modal } from "./Modal";

export interface SalesReviewRecord {
  rev_no: number;
  rejected: number;
  created_at: string;
  reviewed_by_name: string | null;
  lines: StoredReviewLine[];
}

export function SalesReviewImport({
  quote,
  onClose,
  onDone,
}: {
  quote: Pick<Quote, "id" | "number" | "rev_no" | "version">;
  onClose: () => void;
  /** `status`: the quote's status after the import (approved, submitted or draft). */
  onDone: (rejected: number, status: string) => void;
}) {
  const [read, setRead] = useState<ReadReview | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = async (file: File) => {
    setError("");
    setRead(null);
    setFileName(file.name);
    try {
      const { readSalesReview } = await import("../export/salesReview");
      const r = await readSalesReview(await file.arrayBuffer());
      if (r.quoteId !== quote.id) throw new Error(`File ini untuk quotation lain, bukan ${quote.number}.`);
      setRead(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "File tidak bisa dibaca.");
    }
  };

  const blanks = read?.lines.filter((l) => !l.decision) ?? [];
  const rejected = read?.lines.filter((l) => l.decision === "tolak") ?? [];
  const noReason = rejected.filter((l) => !l.reason);
  const stale = read && (read.revNo !== quote.rev_no || read.version !== quote.version);
  const ready = read && !blanks.length && !noReason.length && !stale;
  const allRejected = !!read && rejected.length === read.lines.length;

  const send = async () => {
    if (!read) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.post<{ quote: { status: string } }>(`/quotes/${quote.id}/sales-review`, {
        rev_no: read.revNo,
        version: read.version,
        lines: read.lines.map((l) => ({ id: l.id, decision: l.decision, reason: l.reason })),
      });
      onDone(rejected.length, r.quote.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan hasil cek.");
      setBusy(false);
    }
  };

  const nums = (ls: { lineNo: number }[]) => ls.map((l) => l.lineNo).join(", ");

  return (
    <Modal
      title="Import hasil cek sales"
      sub={`${quote.number} · file "Cek harga" yang sudah diisi ACC/Tolak`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn primary" onClick={() => void send()} disabled={!ready || busy}>
            {busy
              ? "Menyimpan…"
              : !ready
                ? "Kirim hasil cek"
                : allRejected
                  ? "Kembalikan ke manajer"
                  : rejected.length
                    ? `Simpan: ${rejected.length} baris menyusul`
                    : "Simpan: semua ACC"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <label className="field">
          <span>File Excel</span>
          <input
            className="input"
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
            }}
          />
        </label>
        {fileName && !read && !error && <p className="muted small">Membaca {fileName}…</p>}
        {error && <p className="notice error">{error}</p>}
        {read && (
          <>
            <p className="notice info">
              {read.lines.length} baris dicek: <strong>{read.lines.filter((l) => l.decision === "acc").length} ACC</strong>,{" "}
              <strong>{rejected.length} Tolak</strong>
              {blanks.length > 0 && <>, {blanks.length} belum diisi</>}.
              <br />
              Hanya kolom ACC/Tolak dan Alasan yang dibaca. Angka harga di file tidak dipakai.
            </p>
            {stale && (
              <p className="notice error">
                File ini dibuat dari versi lama (revisi {read.revNo}). Quotation sudah berubah sejak itu. Unduh ulang
                file cek harga dan kirim lagi ke sales.
              </p>
            )}
            {blanks.length > 0 && <p className="notice error">Baris {nums(blanks)} belum diisi ACC atau Tolak.</p>}
            {read.invalid.length > 0 && (
              <p className="notice warn">
                Isi yang bukan ACC/Tolak dianggap kosong: {read.invalid.map((l) => `baris ${l.lineNo} ("${l.value}")`).join(", ")}.
              </p>
            )}
            {noReason.length > 0 && <p className="notice error">Baris {nums(noReason)} ditolak tanpa alasan.</p>}
            {rejected.length > 0 && (
              <div>
                <strong className="small">Ditolak sales:</strong>
                <ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {rejected.map((l) => (
                    <li key={l.id}>
                      Baris {l.lineNo} {l.name} — {l.reason || <em>tanpa alasan</em>}
                    </li>
                  ))}
                </ul>
                <p className="muted small" style={{ marginTop: 6 }}>
                  {allRejected
                    ? "Semua baris ditolak: quotation kembali jadi draft (revisi baru) untuk manajer."
                    : "Baris yang ACC tetap disetujui dan bisa langsung dikirim ke klien. Baris yang ditolak keluar dari dokumen sebagai item menyusul dan masuk Perlu diperbaiki. Kalau sisanya jadi melanggar kebijakan, manajer diminta menyetujui ulang."}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** The last sales check of the revision on screen, or the rejection that reopened it. */
export function SalesReviewBanner({ quote, review }: { quote: Quote; review: SalesReviewRecord | null }) {
  if (!review) return null;
  const by = review.reviewed_by_name ?? "sales";
  if (review.rejected > 0 && quote.status === "draft" && review.rev_no === quote.rev_no - 1) {
    const rejected = review.lines.filter((l) => l.decision === "tolak");
    return (
      <div className="notice error" style={{ marginBottom: 12 }}>
        <strong>Ditolak sales ({by}, {fmtDateTime(review.created_at)}):</strong>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {rejected.map((l) => (
            <li key={l.id}>
              Baris {l.lineNo} {l.name} — {l.reason}
            </li>
          ))}
        </ul>
        Perbaiki harga baris itu, lalu ajukan lagi.
      </div>
    );
  }
  if (review.rejected > 0 && review.rev_no === quote.rev_no && quote.status !== "draft") {
    const rejected = review.lines.filter((l) => l.decision === "tolak");
    return (
      <div className="notice warn" style={{ marginBottom: 12 }}>
        <strong>
          Dicek sales ({by}, {fmtDateTime(review.created_at)}): {review.lines.length - rejected.length} baris ACC,{" "}
          {rejected.length} menyusul.
        </strong>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {rejected.map((l) => (
            <li key={l.id}>
              Baris {l.lineNo} {l.name} — {l.reason}
            </li>
          ))}
        </ul>
        {quote.status === "submitted"
          ? "Tanpa baris itu penawaran melanggar kebijakan, jadi menunggu persetujuan ulang manajer."
          : "Penawaran tetap jalan tanpa baris itu. Baris yang menyusul ada di Perlu diperbaiki."}
      </div>
    );
  }
  if (review.rejected === 0 && review.rev_no === quote.rev_no) {
    return (
      <p className="notice ok" style={{ marginBottom: 12 }}>
        Sudah dicek sales ({by}, {fmtDateTime(review.created_at)}): semua {review.lines.length} baris ACC.
      </p>
    );
  }
  return null;
}

/** The toast after an import, by what happened to the quote. */
export function salesImportMessage(rejected: number, status: string): string {
  if (!rejected) return "Semua baris ACC. Hasil cek tersimpan.";
  if (status === "draft") return "Semua baris ditolak. Quotation kembali ke draft untuk manajer.";
  if (status === "submitted") return `${rejected} baris menyusul. Sisa penawaran menunggu persetujuan ulang manajer.`;
  return `${rejected} baris menyusul dan dicatat di Perlu diperbaiki. Sisa penawaran tetap disetujui.`;
}
