/* "+ Klien baru" inside the quote flows (2026-10-07): a rep with a new
   client's list should not have to leave the quote, go to Klien, and come
   back. Rendered inline in the open dialog rather than as a second modal
   (Escape would close both).

   While the name is typed it lists saved clients that look the same, so
   "BAHTERA ADI JAYA PT" picks the existing "PT Bahtera Adi Jaya" instead of
   making a second copy. The server refuses an exact duplicate anyway (409,
   with the existing client), which covers a list that is out of date.

   Required, per Ryoma 2026-10-19: company name, PIC, phone and email
   (shared/clients.ts holds the rule). Only new clients are gated — an
   existing record without them can still be edited elsewhere. */

import { useMemo, useState } from "react";
import { ApiError, api } from "../api";
import { missingNewClientFields, missingNewClientMessage, similarClients, type NewClientField } from "@shared/clients";
import type { Client } from "@shared/types";

const EMPTY = {
  name: "",
  code: "",
  contact_name: "",
  contact_phone: "",
  contact_email: "",
  payment_terms: "",
  address: "",
  delivery_terms: "",
};

type Field = keyof typeof EMPTY;

/** The four a new client cannot go without. */
const REQUIRED: [NewClientField, string, string, string][] = [
  ["contact_name", "Nama PIC", "Nama penanggung jawab", "text"],
  ["contact_phone", "No. HP", "08xx xxxx xxxx", "tel"],
  ["contact_email", "Email", "nama@perusahaan.co.id", "email"],
];

/** The rest: worth having, never a reason to leave the quote. */
const OPTIONAL: [Field, string, string][] = [
  ["code", "Kode klien", ""],
  ["payment_terms", "Termin pembayaran", "30 hari setelah invoice"],
];

export function ClientQuickAdd({
  clients,
  onDone,
  onCancel,
}: {
  clients: Client[];
  /** A new client was saved, or an existing one was picked instead. */
  onDone: (client: Client, isNew: boolean) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState<Client | null>(null);
  // A required field only turns red once the user has passed through it, so an
  // untouched form does not open looking like four mistakes.
  const [touched, setTouched] = useState<Set<Field>>(new Set());

  const similar = useMemo(() => similarClients(form.name, clients), [form.name, clients]);
  const same = similar.find((s) => s.score === 1)?.client ?? existing;
  const missing = missingNewClientFields(form);

  const set = (k: Field, v: string) => {
    setForm({ ...form, [k]: v });
    if (k === "name") {
      setExisting(null);
      setError("");
    }
  };
  const touch = (k: Field) => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));
  const looksWrong = (k: Field) => missing.includes(k as NewClientField) && touched.has(k);

  const save = async () => {
    if (missing.length) {
      setTouched(new Set(missing));
      setError(`Wajib diisi: ${missingNewClientMessage(missing)}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]));
      const r = await api.post<{ client: Client }>("/clients", body);
      onDone(r.client, true);
    } catch (e) {
      const found = e instanceof ApiError && e.status === 409 ? (e.data as { existing?: Client })?.existing : undefined;
      if (found) setExisting(found);
      else setError(e instanceof Error ? e.message : "Gagal menyimpan klien.");
      setBusy(false);
    }
  };

  return (
    <div className="quick-add" role="group" aria-label="Klien baru">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Klien baru</strong>
        <button className="btn small ghost" onClick={onCancel} disabled={busy}>
          Batal
        </button>
      </div>

      <label className="field">
        <span>Nama perusahaan *</span>
        <input
          className={`input${missing.includes("name") && touched.has("name") ? " invalid" : ""}`}
          autoFocus
          placeholder="PT Contoh Sejahtera"
          value={form.name}
          aria-invalid={missing.includes("name") && touched.has("name")}
          onChange={(e) => set("name", e.target.value)}
          onBlur={() => touch("name")}
        />
      </label>

      {same ? (
        <div className="notice warn">
          Klien ini sudah ada: <strong>{same.name}</strong>.{" "}
          <button className="btn small" onClick={() => onDone(same, false)}>
            Pakai klien ini
          </button>
        </div>
      ) : (
        similar.length > 0 && (
          <div className="notice info">
            Mirip dengan klien yang sudah ada:
            <ul className="similar">
              {similar.map(({ client }) => (
                <li key={client.id}>
                  <span>{client.name}</span>
                  <button className="btn small ghost" onClick={() => onDone(client, false)}>
                    Pakai
                  </button>
                </li>
              ))}
            </ul>
            Kalau memang perusahaan lain, lanjutkan saja.
          </div>
        )
      )}

      <div className="field-grid">
        {REQUIRED.map(([key, label, placeholder, type]) => (
          <label className="field" key={key}>
            <span>{label} *</span>
            <input
              className={`input${looksWrong(key) ? " invalid" : ""}`}
              type={type}
              placeholder={placeholder}
              value={form[key]}
              aria-invalid={looksWrong(key)}
              onChange={(e) => set(key, e.target.value)}
              onBlur={() => touch(key)}
            />
          </label>
        ))}
        {OPTIONAL.map(([key, label, placeholder]) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              className="input"
              placeholder={placeholder}
              value={form[key]}
              onChange={(e) => set(key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <details>
        <summary className="muted small">Alamat & pengiriman (opsional)</summary>
        <div className="field-grid" style={{ marginTop: 8 }}>
          <label className="field">
            <span>Alamat</span>
            <input className="input" value={form.address} onChange={(e) => set("address", e.target.value)} />
          </label>
          <label className="field">
            <span>Ketentuan pengiriman</span>
            <input
              className="input"
              value={form.delivery_terms}
              onChange={(e) => set("delivery_terms", e.target.value)}
            />
          </label>
        </div>
      </details>

      {missing.length > 0 && !error && (
        <p className="muted small" style={{ margin: 0 }}>
          Wajib diisi: {missingNewClientMessage(missing)}.
        </p>
      )}

      {error && <p className="notice error">{error}</p>}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" onClick={save} disabled={busy || !!same}>
          {busy ? "Menyimpan…" : "Simpan klien"}
        </button>
      </div>
    </div>
  );
}
