import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
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
    <fieldset className="field" style={{ marginTop: 12, border: 0, padding: 0 }}>
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? STARTER : null)} />
        <span>Template dokumen khusus klien ini (format tender)</span>
      </label>
      {!value ? (
        <p className="muted small" style={{ margin: "4px 0 0" }}>Tanpa template, penawaran dicetak dengan format standar.</p>
      ) : (
        <div style={{ marginTop: 8, gap: 8, display: "flex", flexDirection: "column" }}>
          <p className="muted small" style={{ margin: 0 }}>
            Berlaku untuk PDF, pratinjau dokumen dan sheet Penawaran di Excel. Opsi "tanpa Qty/Total" di quotation tetap bisa menyembunyikan kolom.
            Kolom Keterangan berisi catatan per baris.
          </p>
          {columns.map((c, i) => (
            <div className="row" key={c.key} style={{ gap: 6 }}>
              <span className="muted small" style={{ width: 96 }}>{DOC_COLUMN_LABELS[c.key]}</span>
              <input
                className="input"
                aria-label={`Judul kolom ${DOC_COLUMN_LABELS[c.key]}`}
                maxLength={40}
                value={c.label}
                onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <button type="button" className="btn small ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Naikkan ${c.label}`}>↑</button>
              <button type="button" className="btn small ghost" disabled={i === columns.length - 1} onClick={() => move(i, 1)} aria-label={`Turunkan ${c.label}`}>↓</button>
              <button
                type="button" className="icon-btn" aria-label={`Hapus kolom ${c.label}`}
                disabled={c.key === "name" || c.key === "price"}
                onClick={() => setColumns(columns.filter((_, j) => j !== i))}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
          {unused.length > 0 && (
            <select
              className="input" aria-label="Tambah kolom" value=""
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
          <label className="row" style={{ gap: 6 }}>
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
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ clients: Client[] }>("/clients")
      .then((r) => setClients(r.clients))
      .catch((e) => toast(e.message, "error"))
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

  const missingNow = editing && !editing.id ? missingNewClientFields(editing) : [];

  return (
    <main className="hk-main">
      <div className="hk-page-head">
        <div>
          <h1>Klien</h1>
          <p>Data klien mengisi otomatis termin dan alamat di setiap quotation baru.</p>
        </div>
        <button className="btn primary" onClick={() => open({ ...EMPTY })}>
          <Icon name="plus" size={16} /> Klien baru
        </button>
      </div>

      <div className="card">
        {loading ? (
          <div className="card-body loading"><span className="dots"><i /><i /><i /></span> Memuat…</div>
        ) : clients.length === 0 ? (
          <div className="card-body empty">
            <Icon name="building" size={28} />
            <h3>Belum ada klien</h3>
            <p>Tambahkan klien pertama supaya quotation langsung terisi alamat dan terminnya.</p>
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
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
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="l">
                      <strong>{c.name}</strong>
                      {c.address && <div className="muted small">{c.address}</div>}
                    </td>
                    <td className="l muted">{c.code || "—"}</td>
                    <td className="l">
                      {c.contact_name || "—"}
                      {c.contact_email && <div className="muted small">{c.contact_email}</div>}
                    </td>
                    <td className="l muted small">{c.payment_terms}</td>
                    <td className="num">{c.quote_count ?? 0}</td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
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
            <p className="muted small" style={{ margin: "10px 0 0" }}>
              Wajib diisi: {missingNewClientMessage(missingNow)}.
            </p>
          )}
          <label className="field" style={{ marginTop: 12 }}>
            <span>Alamat</span>
            <textarea
              className="textarea"
              rows={2}
              value={editing.address}
              onChange={(e) => setEditing({ ...editing, address: e.target.value })}
            />
          </label>
          <DocTemplateFields value={editing.doc_template} onChange={(doc_template) => setEditing({ ...editing, doc_template })} />
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title={`Hapus ${deleting.name}?`}
          message="Klien yang masih dipakai quotation tidak bisa dihapus."
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
