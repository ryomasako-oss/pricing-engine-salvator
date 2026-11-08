import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { LoadError } from "../components/LoadError";
import { Icon } from "../components/Icon";
import { Modal, ConfirmModal } from "../components/Modal";
import { NEW_CLIENT_REQUIRED, missingNewClientFields, missingNewClientMessage } from "@shared/clients";
import { DEFAULT_DOC_TITLE, DOC_COLUMN_KEYS, DOC_COLUMN_LABELS } from "@shared/docColumns";
import type { Client, DocTemplate } from "@shared/types";

const EMPTY = {
  name: "", code: "", address: "", contact_name: "", contact_email: "",
  contact_phone: "", payment_terms: "30 hari setelah invoice",
  delivery_terms: "Franco Jakarta, jadwal mingguan",
  accurate_customer_no: "",
  doc_template: null as DocTemplate | null,
};

/** What a new template starts from: the standard document's columns. */
const STARTER: DocTemplate = {
  columns: (["no", "code", "name", "uom", "qty", "price", "total"] as const).map((key) => ({ key, label: DOC_COLUMN_LABELS[key] })),
};

/** The client's tender format (shared/docColumns.ts): columns, headings and text of the customer document. */
function DocTemplateFields({ value, onChange }: { value: DocTemplate | null; onChange: (t: DocTemplate | null) => void }) {
  const columns = value?.columns ?? [];
  const unused = DOC_COLUMN_KEYS.filter((k) => !columns.some((c) => c.key === k));
  const setColumns = (cs: NonNullable<DocTemplate["columns"]>) => value && onChange({ ...value, columns: cs });
  const move = (i: number, by: number) => {
    const cs = [...columns];
    [cs[i], cs[i + by]] = [cs[i + by], cs[i]];
    setColumns(cs);
  };
  return (
    <fieldset className="fieldset form-stack">
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? STARTER : null)} />
        <span>Template dokumen khusus klien ini (format tender)</span>
      </label>
      {!value ? (
        <p className="field-help">Tanpa template, penawaran dicetak dengan format standar.</p>
      ) : (
        <div className="form-stack">
          <p className="field-help">
            Berlaku untuk PDF, pratinjau dokumen dan sheet Penawaran di Excel. Opsi "tanpa Qty/Total" di quotation tetap bisa menyembunyikan kolom.
            Kolom Keterangan berisi catatan per baris.
          </p>
          <div className="doc-cols">
          {columns.map((c, i) => (
            <div className="doc-col-row" key={c.key}>
              <span className="muted small">{DOC_COLUMN_LABELS[c.key]}</span>
              <input
                className="input"
                aria-label={`Judul kolom ${DOC_COLUMN_LABELS[c.key]}`}
                maxLength={40}
                value={c.label}
                onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Naikkan ${c.label}`} title="Naikkan">
                <Icon name="chevron-up" size={15} />
              </button>
              <button type="button" className="icon-btn" disabled={i === columns.length - 1} onClick={() => move(i, 1)} aria-label={`Turunkan ${c.label}`} title="Turunkan">
                <Icon name="chevron-down" size={15} />
              </button>
              <button
                type="button" className="icon-btn" aria-label={`Hapus kolom ${c.label}`}
                disabled={c.key === "name" || c.key === "price"}
                onClick={() => setColumns(columns.filter((_, j) => j !== i))}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
          </div>
          {unused.length > 0 && (
            <select
              className="select" aria-label="Tambah kolom" value=""
              onChange={(e) => {
                const key = e.target.value as (typeof unused)[number];
                if (key) setColumns([...columns, { key, label: DOC_COLUMN_LABELS[key] }]);
              }}
            >
              <option value="">+ Tambah kolom…</option>
              {unused.map((k) => <option key={k} value={k}>{DOC_COLUMN_LABELS[k]}</option>)}
            </select>
          )}
          <label className="field">
            <span>Judul dokumen</span>
            <input
              className="input" maxLength={80} placeholder={DEFAULT_DOC_TITLE} value={value.title ?? ""}
              onChange={(e) => onChange({ ...value, title: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Paragraf pembuka</span>
            <textarea className="textarea" rows={2} maxLength={2000} value={value.opening ?? ""} onChange={(e) => onChange({ ...value, opening: e.target.value })} />
          </label>
          <label className="field">
            <span>Paragraf penutup</span>
            <textarea className="textarea" rows={2} maxLength={2000} value={value.closing ?? ""} onChange={(e) => onChange({ ...value, closing: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={value.showTotals !== false} onChange={(e) => onChange({ ...value, showTotals: e.target.checked ? undefined : false })} />
            <span>Tampilkan subtotal, PPN dan total</span>
          </label>
        </div>
      )}
    </fieldset>
  );
}

/** Labels, and which of them a *new* client cannot go without (shared/clients.ts). */
const FIELDS: [keyof typeof EMPTY, string][] = [
  ["name", "Nama perusahaan"],
  ["contact_name", "Nama PIC"],
  ["contact_phone", "No. HP"],
  ["contact_email", "Email"],
  ["code", "Kode klien"],
  ["accurate_customer_no", "No. customer Accurate (C.xxxxx)"],
  ["payment_terms", "Termin pembayaran"],
  ["delivery_terms", "Ketentuan pengiriman"],
];

export function ClientsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [clients, setClients] = useState<(Client & { quote_count?: number })[]>([]);
  const [editing, setEditing] = useState<(typeof EMPTY & { id?: number }) | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [deleting, setDeleting] = useState<(Client & { quote_count?: number }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api
      .get<{ clients: Client[] }>("/clients")
      .then((r) => setClients(r.clients))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(load, [load]);

  const open = (client: typeof EMPTY & { id?: number }) => {
    setAttempted(false);
    setEditing(client);
  };

  const save = async () => {
    if (!editing) return;
    // Only a new client must carry a PIC, phone and email; an older record
    // someone is just fixing up is left alone (shared/clients.ts).
    const missing = editing.id ? [] : missingNewClientFields(editing);
    if (missing.length) {
      setAttempted(true);
      toast(`Wajib diisi: ${missingNewClientMessage(missing)}.`, "error");
      return;
    }
    try {
      const body = { ...EMPTY, ...editing };
      if (editing.id) await api.put(`/clients/${editing.id}`, body);
      else await api.post("/clients", body);
      setEditing(null);
      load();
      toast("Klien tersimpan.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan klien.", "error");
    }
  };

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      q
        ? clients.filter((c) => [c.name, c.code, c.contact_name, c.contact_email].some((v) => v?.toLowerCase().includes(q)))
        : clients,
    [clients, q],
  );

  const missingNow = editing && !editing.id ? missingNewClientFields(editing) : [];

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Klien</h1>
          <p>Data klien mengisi otomatis termin dan alamat di setiap quotation baru.</p>
        </div>
        <button className="btn primary" onClick={() => open({ ...EMPTY })}>
          Klien baru
        </button>
      </div>

      <div className="card">
        <div className="toolbar">
          <input
            className="input toolbar-search"
            type="search"
            placeholder="Cari nama, kode, atau PIC"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Cari klien"
          />
          <span className="grow" />
          {!loading && !loadError && <span className="muted small num">{q ? `${shown.length} dari ${clients.length}` : clients.length} klien</span>}
        </div>
        {loadError ? (
          <LoadError message={loadError} onRetry={load} />
        ) : loading ? (
          <div className="card-body skeleton-list" role="status" aria-label="Memuat klien…">
            {[0, 1, 2, 3, 4].map((i) => <span key={i} className="skeleton" />)}
          </div>
        ) : clients.length === 0 ? (
          <div className="card-body empty">
            <h3>Belum ada klien</h3>
            <p>Tambahkan klien pertama supaya quotation langsung terisi alamat dan terminnya.</p>
            <button className="btn primary" onClick={() => open({ ...EMPTY })}>
              Klien baru
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="card-body empty">
            <h3>Tidak ada klien yang cocok</h3>
            <p>Coba nama, kode, atau nama PIC lain.</p>
            <button className="btn" onClick={() => setQuery("")}>Hapus pencarian</button>
          </div>
        ) : (
          <div className="table-wrap flush">
            <table className="table stack">
              <thead>
                <tr>
                  <th className="l">Nama</th>
                  <th className="l">Kode</th>
                  <th className="l">Kontak</th>
                  <th className="l">Termin</th>
                  <th>Quotation</th>
                  <th aria-label="Aksi" />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <td className="l stack-title">
                      <span className="cell-title">{c.name}</span>
                      {c.address && <div className="muted small">{c.address}</div>}
                    </td>
                    <td className="l muted" data-label="Kode">{c.code || "—"}</td>
                    <td className="l" data-label="Kontak">
                      <div>
                        {c.contact_name || "—"}
                        {c.contact_email && <div className="muted small">{c.contact_email}</div>}
                      </div>
                    </td>
                    <td className="l muted small" data-label="Termin">{c.payment_terms}</td>
                    <td className="num" data-label="Quotation">{c.quote_count ?? 0}</td>
                    <td className="stack-action">
                      <div className="row-actions">
                        <button className="btn small ghost" onClick={() => open({ ...c })}>
                          Ubah
                        </button>
                        {can("delete_clients") && (
                          <button className="icon-btn" onClick={() => setDeleting(c)} aria-label={`Hapus ${c.name}`}>
                            <Icon name="trash" size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Modal
          title={editing.id ? "Ubah klien" : "Klien baru"}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setEditing(null)}>Batal</button>
              <button className="btn primary" onClick={save} disabled={!editing.name.trim()}>
                Simpan
              </button>
            </>
          }
        >
          <div className="form-stack">
          <div className="field-grid">
            {FIELDS.map(([key, label]) => {
              const starred = !editing.id && NEW_CLIENT_REQUIRED.some(([f]) => f === key);
              const wrong = attempted && (missingNow as string[]).includes(key);
              return (
                <label className="field" key={key}>
                  <span>{label}{starred ? " *" : ""}</span>
                  <input
                    className={`input${wrong ? " invalid" : ""}`}
                    aria-invalid={wrong}
                    value={(editing as unknown as Record<string, string>)[key] ?? ""}
                    onChange={(e) => setEditing({ ...editing, [key]: e.target.value })}
                  />
                </label>
              );
            })}
          </div>
          {missingNow.length > 0 && (
            <p className="field-help">
              Wajib diisi: {missingNewClientMessage(missingNow)}.
            </p>
          )}
          <label className="field">
            <span>Alamat</span>
            <textarea
              className="textarea"
              rows={2}
              value={editing.address}
              onChange={(e) => setEditing({ ...editing, address: e.target.value })}
            />
          </label>
          <DocTemplateFields value={editing.doc_template} onChange={(doc_template) => setEditing({ ...editing, doc_template })} />
          </div>
        </Modal>
      )}

      {deleting && !!deleting.quote_count && (
        // The server refuses while quotes use the client (409): no delete button to press.
        <Modal
          title={`${deleting.name} belum bisa dihapus`}
          onClose={() => setDeleting(null)}
          footer={<button className="btn primary" onClick={() => setDeleting(null)}>Tutup</button>}
        >
          <p>
            Klien ini masih dipakai {deleting.quote_count} quotation. Hapus atau pindahkan quotation itu ke klien lain dulu.
          </p>
        </Modal>
      )}
      {deleting && !deleting.quote_count && (
        <ConfirmModal
          title={`Hapus ${deleting.name}?`}
          message="Data klien ini dihapus permanen dan tidak bisa dipilih lagi di quotation baru."
          confirmLabel="Hapus klien"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.del(`/clients/${deleting.id}`);
              setDeleting(null);
              load();
              toast("Klien dihapus.", "success");
            } catch (e) {
              toast(e instanceof Error ? e.message : "Gagal menghapus.", "error");
            }
          }}
        />
      )}
    </main>
  );
}
