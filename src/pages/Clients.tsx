import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Icon } from "../components/Icon";
import { Modal, ConfirmModal } from "../components/Modal";
import { NEW_CLIENT_REQUIRED, missingNewClientFields, missingNewClientMessage } from "@shared/clients";
import type { Client } from "@shared/types";

const EMPTY = {
  name: "", code: "", address: "", contact_name: "", contact_email: "",
  contact_phone: "", payment_terms: "30 hari setelah invoice",
  delivery_terms: "Franco Jakarta, jadwal mingguan",
};

/** Labels, and which of them a *new* client cannot go without (shared/clients.ts). */
const FIELDS: [keyof typeof EMPTY, string][] = [
  ["name", "Nama perusahaan"],
  ["contact_name", "Nama PIC"],
  ["contact_phone", "No. HP"],
  ["contact_email", "Email"],
  ["code", "Kode klien"],
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
