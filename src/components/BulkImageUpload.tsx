import { useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { BULK_STATE_LABEL, codesToCheck, planRows, type BulkRow } from "../lib/bulkImagePlan";
import { uploadItemImage } from "../lib/itemImageUpload";
import { Modal } from "./Modal";

const MAX_FILES = 1000;
const CHECK_CHUNK = 500;
const PARALLEL = 3;

type Result = { status: "waiting" | "sending" | "done" | "failed"; message?: string };

/** Unggah banyak gambar barang sekaligus. Nama berkas = kode barang (101885.jpg). Pratinjau
 *  menandai tiap berkas dulu; hanya yang cocok dengan katalog yang dikirim, dan yang sudah
 *  punya gambar akan ditimpa. Hanya dipasang untuk peran dengan izin edit_catalog. */
export function BulkImageUpload({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [results, setResults] = useState<Map<number, Result>>(new Map());
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [capped, setCapped] = useState(false);
  const cancelled = useRef(false);

  const sendable = (rows ?? []).map((r, i) => ({ r, i })).filter(({ r }) => r.state === "ready" || r.state === "overwrite");
  const overwriting = sendable.filter(({ r }) => r.state === "overwrite").length;
  const finished = sendable.length > 0 && sendable.every(({ i }) => ["done", "failed"].includes(results.get(i)?.status ?? ""));

  async function choose(list: FileList | null) {
    if (!list?.length) return;
    const all = [...list];
    setCapped(all.length > MAX_FILES);
    const files = all.slice(0, MAX_FILES);
    setChecking(true);
    setResults(new Map());
    try {
      const codes = codesToCheck(files);
      const known = new Map<string, { code: string; hasImage: boolean }>();
      for (let i = 0; i < codes.length; i += CHECK_CHUNK) {
        const { items } = await api.post<{ items: { input: string; code: string; hasImage: boolean }[] }>(
          "/item-image/_check",
          { codes: codes.slice(i, i + CHECK_CHUNK) },
        );
        for (const it of items) known.set(it.input.toLowerCase(), { code: it.code, hasImage: it.hasImage });
      }
      setRows(planRows(files, known));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal memeriksa kode barang.", "error");
    } finally {
      setChecking(false);
      for (const input of [filesInput, folderInput]) if (input.current) input.current.value = "";
    }
  }

  async function send() {
    setSending(true);
    cancelled.current = false;
    const queue = [...sendable];
    const mark = (i: number, r: Result) => setResults((old) => new Map(old).set(i, r));
    sendable.forEach(({ i }) => mark(i, { status: "waiting" }));
    let ok = 0;
    let failed = 0;
    const worker = async () => {
      for (let job = queue.shift(); job && !cancelled.current; job = queue.shift()) {
        mark(job.i, { status: "sending" });
        try {
          await uploadItemImage(job.r.code!, job.r.file);
          ok++;
          mark(job.i, { status: "done" });
        } catch (e) {
          failed++;
          mark(job.i, { status: "failed", message: e instanceof Error ? e.message : "Gagal." });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setSending(false);
    if (ok) onDone();
    toast(`${ok} gambar tersimpan${failed ? `, ${failed} gagal` : ""}.`, failed ? "error" : "success");
  }

  const close = () => {
    cancelled.current = true;
    onClose();
  };

  return (
    <Modal
      title="Unggah gambar massal"
      sub="Nama berkas = kode barang, misalnya 101885.jpg"
      size="wide"
      onClose={close}
      footer={
        <>
          <button className="btn ghost" onClick={close}>{finished ? "Tutup" : "Batal"}</button>
          <button className="btn primary" disabled={sending || checking || sendable.length === 0 || finished} onClick={send}>
            {sending ? "Mengirim…" : `Kirim ${sendable.length} gambar`}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <input ref={filesInput} type="file" accept="image/*" multiple hidden onChange={(e) => choose(e.target.files)} />
        <input
          ref={folderInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          // @ts-expect-error webkitdirectory belum ada di tipe React, tetapi didukung Chrome, Brave, Firefox, Safari.
          webkitdirectory=""
          onChange={(e) => choose(e.target.files)}
        />
        <div className="row-wrap">
          <button className="btn" disabled={sending || checking} onClick={() => filesInput.current?.click()}>
            Pilih berkas
          </button>
          <button className="btn" disabled={sending || checking} onClick={() => folderInput.current?.click()}>
            Pilih folder
          </button>
          <span className="muted small">JPG, PNG, atau WebP; diperkecil otomatis. Maksimum {MAX_FILES} berkas sekali pilih.</span>
        </div>

        {checking && <p className="muted">Memeriksa kode barang…</p>}
        {capped && <p className="notice warn">Hanya {MAX_FILES} berkas pertama yang diproses. Pilih sisanya setelah ini selesai.</p>}

        {rows && (
          <>
            <p>
              <b>{sendable.length - overwriting}</b> baru, <b>{overwriting}</b> menimpa gambar lama,{" "}
              <b>{rows.length - sendable.length}</b> dilewati. Gambar lama yang ditimpa tidak bisa dikembalikan.
            </p>
            <div className="scroll-box">
              <table className="table">
                <thead>
                  <tr>
                    <th className="l">Berkas</th>
                    <th className="l">Kode di katalog</th>
                    <th className="l">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const res = results.get(i);
                    const ok = r.state === "ready" || r.state === "overwrite";
                    return (
                      <tr key={i}>
                        <td className="l">{r.file.name}</td>
                        <td className="l muted">{r.code ?? "—"}</td>
                        <td className="l">
                          {res?.status === "done" ? (
                            <span className="badge green">Tersimpan</span>
                          ) : res?.status === "failed" ? (
                            <span className="badge red" title={res.message}>Gagal: {res.message}</span>
                          ) : res?.status === "sending" ? (
                            <span className="muted">Mengirim…</span>
                          ) : (
                            <span className={`badge ${!ok ? "red" : r.state === "overwrite" ? "amber" : "green"}`}>
                              {BULK_STATE_LABEL[r.state]}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
