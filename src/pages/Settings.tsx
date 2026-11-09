import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Modal } from "../components/Modal";
import { PasswordInput } from "../components/PasswordInput";
import { fmtDateTime, grp, rp } from "@shared/format";
import type { PasswordResetRequest, PricingPolicy, Role, User } from "@shared/types";
import type { CompanyInfo } from "../components/QuotationDoc";

export function SettingsPage() {
  const { user, can, refreshUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [policy, setPolicy] = useState<PricingPolicy | null>(null);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [excelPassword, setExcelPassword] = useState("");
  const [excelPasswordSet, setExcelPasswordSet] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState({ current: "", next: "", confirm: "" });
  const [resettingUser, setResettingUser] = useState<User | null>(null);
  const [resetRequests, setResetRequests] = useState<PasswordResetRequest[]>([]);
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [savingPhone, setSavingPhone] = useState(false);
  const [tgPhone, setTgPhone] = useState(user?.telegram_phone ?? "");
  const [savingTg, setSavingTg] = useState(false);

  const loadUsers = useCallback(() => {
    if (!can("manage_users")) return;
    api.get<{ users: User[] }>("/auth/users").then((r) => setUsers(r.users)).catch(() => undefined);
  }, [can]);

  const loadResetRequests = useCallback(() => {
    if (!can("manage_users")) return;
    api
      .get<{ requests: PasswordResetRequest[] }>("/auth/password-reset-requests")
      .then((r) => setResetRequests(r.requests))
      .catch(() => undefined);
  }, [can]);

  useEffect(() => {
    api
      .get<{ policy: PricingPolicy; company: CompanyInfo; excelPassword?: string }>("/settings")
      .then((r) => {
        setPolicy(r.policy);
        setCompany(r.company);
        setExcelPasswordSet(!!r.excelPassword);
      })
      .catch((e) => toast(e.message, "error"));
    loadUsers();
    loadResetRequests();
  }, [loadUsers, loadResetRequests, toast]);

  const dismissResetRequest = async (id: number) => {
    try {
      await api.del(`/auth/password-reset-requests/${id}`);
      setResetRequests((rs) => rs.filter((r) => r.id !== id));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal.", "error");
    }
  };

  const savePolicy = async () => {
    if (!policy) return;
    try {
      await api.put("/settings/policy", policy);
      toast("Kebijakan harga tersimpan.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan.", "error");
    }
  };

  const MAX_LOGO_BYTES = 500_000;

  const onLogoSelected = (file: File | undefined) => {
    if (!file || !company) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      toast("Format logo harus PNG, JPEG, atau WEBP.", "error");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast("Ukuran logo maksimum 500 KB.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCompany({ ...company, logo: reader.result as string });
    reader.readAsDataURL(file);
  };

  const saveCompany = async () => {
    if (!company) return;
    try {
      await api.put("/settings/company", company);
      toast("Identitas perusahaan tersimpan.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan.", "error");
    }
  };

  const changePassword = async () => {
    if (password.next !== password.confirm) {
      toast("Konfirmasi kata sandi tidak cocok.", "error");
      return;
    }
    try {
      await api.post("/auth/password", { current: password.current, next: password.next });
      setPassword({ current: "", next: "", confirm: "" });
      toast("Kata sandi diperbarui.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal mengubah kata sandi.", "error");
    }
  };

  const saveTgPhone = async () => {
    setSavingTg(true);
    try {
      await api.patch("/auth/profile", { telegram_phone: tgPhone });
      await refreshUser();
      toast("Nomor Telegram disimpan.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan nomor Telegram.", "error");
    } finally {
      setSavingTg(false);
    }
  };

  const savePhone = async () => {
    setSavingPhone(true);
    try {
      await api.patch("/auth/profile", { phone });
      await refreshUser();
      toast("Nomor WhatsApp disimpan.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan nomor WhatsApp.", "error");
    } finally {
      setSavingPhone(false);
    }
  };

  // One section at a time, picked in the left sub-nav; ?bagian= makes it linkable
  // (the admin's "Permintaan reset sandi" tile opens ?bagian=reset).
  const sections = [
    // From permissions, not from loaded data, so the chosen section doesn't jump when it arrives
    // (the server sends the policy only to view_costs: server/staffView.ts settingsForViewer).
    { key: "kebijakan", label: "Kebijakan harga", show: can("view_costs") },
    { key: "identitas", label: "Identitas dokumen", show: true },
    { key: "excel", label: "Password Excel", show: can("manage_company") },
    { key: "notifikasi", label: "Notifikasi", show: true },
    { key: "sandi", label: "Kata sandi saya", show: true },
    { key: "pengguna", label: "Pengguna", show: can("manage_users") },
    { key: "reset", label: "Permintaan reset", show: can("manage_users"), count: resetRequests.length },
  ].filter((x) => x.show);
  const [params, setParams] = useSearchParams();
  const wanted = params.get("bagian");
  const current = sections.find((x) => x.key === wanted)?.key ?? sections[0]?.key;
  const go = (key: string) => setParams({ bagian: key }, { replace: true });
  const readOnlyPolicy = !can("manage_policy");
  const readOnlyCompany = !can("manage_company");

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Pengaturan</h1>
          <p>Kebijakan harga, identitas dokumen, notifikasi, dan akun. Bagian yang tampil mengikuti izin Anda.</p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="sub-nav" aria-label="Bagian pengaturan">
          {sections.map((x) => (
            <button
              key={x.key}
              type="button"
              className={x.key === current ? "on" : ""}
              aria-current={x.key === current ? "true" : undefined}
              onClick={() => go(x.key)}
            >
              <span>{x.label}</span>
              {!!x.count && <span className="nav-count num">{grp(x.count)}</span>}
            </button>
          ))}
        </nav>

        <div className="settings-body">
        {((current === "kebijakan" && !policy) || (current === "identitas" && !company)) && (
          <section className="card">
            <div className="card-body skeleton-list" role="status" aria-label="Memuat pengaturan…">
              {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
            </div>
          </section>
        )}
        {current === "kebijakan" && policy && (
          <section className="card">
            <div className="card-head">
              <div className="card-title">
                <h2>Kebijakan harga</h2>
                <span className="muted small">
                  Batas yang memicu persetujuan manajer.{readOnlyPolicy ? " Hanya admin yang bisa mengubah." : ""}
                </span>
              </div>
            </div>
            <div className="card-body form-stack">
              <div className="field-grid">
                <label className="field">
                  <span>Net margin minimum</span>
                  <div className="input-affix">
                    <input
                      className="input" type="number" min="0" max="90" step="0.5" disabled={readOnlyPolicy}
                      value={+(policy.minNetMargin * 100).toFixed(2)}
                      onChange={(e) => setPolicy({ ...policy, minNetMargin: Number(e.target.value) / 100 })}
                    />
                    <span>%</span>
                  </div>
                </label>
                <label className="field">
                  <span>Margin minimum per item</span>
                  <div className="input-affix">
                    <input
                      className="input" type="number" min="-50" max="90" step="0.5" disabled={readOnlyPolicy}
                      value={+(policy.minLineMargin * 100).toFixed(2)}
                      onChange={(e) => setPolicy({ ...policy, minLineMargin: Number(e.target.value) / 100 })}
                    />
                    <span>%</span>
                  </div>
                </label>
                <label className="field">
                  <span>Diskon basket maksimum</span>
                  <div className="input-affix">
                    <input
                      className="input" type="number" min="0" max="100" step="1" disabled={readOnlyPolicy}
                      value={+(policy.maxBasketDiscount * 100).toFixed(2)}
                      onChange={(e) => setPolicy({ ...policy, maxBasketDiscount: Number(e.target.value) / 100 })}
                    />
                    <span>%</span>
                  </div>
                </label>
                <label className="field">
                  <span>Ambang nilai wajib persetujuan</span>
                  <div className="input-affix prefix">
                    <span>Rp</span>
                    <input
                      className="input" type="number" min="0" step="1000000" disabled={readOnlyPolicy}
                      value={policy.approvalValueThreshold}
                      onChange={(e) => setPolicy({ ...policy, approvalValueThreshold: Number(e.target.value) })}
                    />
                  </div>
                  <small className="field-help">{rp(policy.approvalValueThreshold)} per bulan</small>
                </label>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={readOnlyPolicy}
                  checked={policy.allowBelowCost}
                  onChange={(e) => setPolicy({ ...policy, allowBelowCost: e.target.checked })}
                />
                <span>Izinkan item dijual di bawah landed cost</span>
              </label>
              {!readOnlyPolicy && (
                <div className="form-actions">
                  <button className="btn primary" onClick={savePolicy}>Simpan kebijakan</button>
                </div>
              )}
            </div>
          </section>
        )}

        {current === "identitas" && company && (
          <section className="card">
            <div className="card-head">
              <div className="card-title">
                <h2>Identitas di dokumen penawaran</h2>
                <span className="muted small">
                  Muncul di kop PDF, pratinjau, dan Excel penawaran.{readOnlyCompany ? " Hanya admin yang bisa mengubah." : ""}
                </span>
              </div>
            </div>
            <div className="card-body form-stack">
              <div className="field">
                <span>Logo perusahaan</span>
                <div className="row-wrap">
                  {company.logo ? (
                    <img className="logo-preview" src={company.logo} alt="Logo" />
                  ) : (
                    <span className="muted small">Belum ada logo; dokumen memakai nama merek dagang sebagai teks.</span>
                  )}
                  {!readOnlyCompany && (
                    <>
                      <input
                        id="logo-upload"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        onChange={(e) => onLogoSelected(e.target.files?.[0])}
                      />
                      <label htmlFor="logo-upload" className="btn small">
                        {company.logo ? "Ganti logo" : "Unggah logo"}
                      </label>
                      {company.logo && (
                        <button className="btn small ghost" onClick={() => setCompany({ ...company, logo: "" })}>
                          Hapus
                        </button>
                      )}
                    </>
                  )}
                </div>
                {!readOnlyCompany && <small className="field-help">PNG, JPEG, atau WEBP, maksimum 500 KB.</small>}
              </div>
              <div className="field-grid">
                {([
                  ["brand", "Merek dagang"],
                  ["name", "Nama badan hukum"],
                  ["tagline", "Tagline"],
                  ["phone", "Telepon"],
                  ["email", "Email"],
                  ["npwp", "NPWP"],
                ] as const).map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <input
                      className="input"
                      disabled={readOnlyCompany}
                      value={company[key]}
                      onChange={(e) => setCompany({ ...company, [key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <label className="field">
                <span>Alamat</span>
                <textarea
                  className="textarea" rows={2} disabled={readOnlyCompany}
                  value={company.address}
                  onChange={(e) => setCompany({ ...company, address: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Rekening pembayaran</span>
                <input
                  className="input" disabled={readOnlyCompany}
                  value={company.bank}
                  onChange={(e) => setCompany({ ...company, bank: e.target.value })}
                />
              </label>
              {!readOnlyCompany && (
                <div className="form-actions">
                  <button className="btn primary" onClick={saveCompany}>Simpan identitas</button>
                </div>
              )}
            </div>
          </section>
        )}

        {current === "excel" && (
          <section className="card">
            <div className="card-head">
              <div className="card-title">
                <h2>Password Excel cek harga</h2>
                <span className="muted small">Mengunci file "Cek harga" yang manajer kirim ke sales.</span>
              </div>
              <span className={`badge ${excelPasswordSet ? "green" : "amber"}`}>{excelPasswordSet ? "Sudah diatur" : "Belum diatur"}</span>
            </div>
            <div className="card-body form-stack">
              <p className="field-help">
                Sales hanya bisa mengisi ACC/Tolak. Manajer dan admin bisa melihat password ini; sales tidak. Kunci Excel mudah
                dibongkar, jadi angka di file tidak pernah dibaca balik oleh aplikasi; yang dibaca hanya ACC/Tolak dan alasannya.
                {!excelPasswordSet && " Selama belum diatur, file cek harga belum bisa dibuat."}
              </p>
              <div className="inline-form">
                <label className="field">
                  <span>{excelPasswordSet ? "Password baru" : "Password"}</span>
                  <PasswordInput value={excelPassword} onChange={setExcelPassword} autoComplete="new-password" />
                </label>
                <button
                  className="btn primary"
                  disabled={excelPassword.length < 6}
                  onClick={async () => {
                    try {
                      await api.put("/settings/excel-password", { password: excelPassword });
                      setExcelPassword("");
                      setExcelPasswordSet(true);
                      toast("Password Excel disimpan.", "success");
                    } catch (e) {
                      toast(e instanceof Error ? e.message : "Gagal menyimpan.", "error");
                    }
                  }}
                >
                  Simpan password
                </button>
              </div>
            </div>
          </section>
        )}

        {current === "notifikasi" && (
          <section className="card">
            <div className="card-head">
              <div className="card-title">
                <h2>Notifikasi WhatsApp</h2>
                <span className="muted small">Kosongkan nomor untuk mematikan notifikasi WhatsApp.</span>
              </div>
            </div>
            <div className="card-body form-stack">
              <p className="field-help">
                Dipakai untuk mengirim WhatsApp saat ada quotation yang butuh persetujuan Anda, atau saat quotation Anda diputuskan.
              </p>
              <div className="inline-form">
                <label className="field">
                  <span>Nomor WhatsApp saya</span>
                  <input className="input" placeholder="+62 812-3456-7890" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </label>
                <button className="btn primary" onClick={savePhone} disabled={savingPhone || phone === (user?.phone ?? "")}>
                  {savingPhone ? "Menyimpan…" : "Simpan nomor"}
                </button>
              </div>
            </div>
          </section>
        )}

        {current === "notifikasi" && (
          <section className="card">
            <div className="card-head">
              <div className="card-title">
                <h2>Silvy di Telegram</h2>
                <span className="muted small">Kosongkan bila nomor Telegram Anda sama dengan nomor WhatsApp di atas.</span>
              </div>
            </div>
            <div className="card-body form-stack">
              <p className="field-help">
                Bot Telegram @SilvySalvatorBot mengenali Anda dari nomor ini saat Anda menekan "Bagikan nomor saya".
              </p>
              <div className="inline-form">
                <label className="field">
                  <span>Nomor Telegram saya</span>
                  <input className="input" placeholder={phone || "+62 812-3456-7890"} value={tgPhone} onChange={(e) => setTgPhone(e.target.value)} />
                </label>
                <button className="btn primary" onClick={saveTgPhone} disabled={savingTg || tgPhone === (user?.telegram_phone ?? "")}>
                  {savingTg ? "Menyimpan…" : "Simpan nomor"}
                </button>
              </div>
            </div>
          </section>
        )}

        {current === "sandi" && (
          <section className="card">
            <div className="card-head"><h2>Kata sandi saya</h2></div>
            <div className="card-body form-stack">
              <div className="field-grid">
                <label className="field">
                  <span>Kata sandi saat ini</span>
                  <PasswordInput autoComplete="current-password" value={password.current} onChange={(v) => setPassword({ ...password, current: v })} />
                </label>
                <label className="field">
                  <span>Kata sandi baru (min. 8 karakter)</span>
                  <PasswordInput autoComplete="new-password" value={password.next} onChange={(v) => setPassword({ ...password, next: v })} />
                </label>
                <label className="field">
                  <span>Ulangi kata sandi baru</span>
                  <PasswordInput autoComplete="new-password" value={password.confirm} onChange={(v) => setPassword({ ...password, confirm: v })} />
                </label>
              </div>
              <div className="form-actions">
                <button className="btn primary" onClick={changePassword} disabled={!password.current || password.next.length < 8}>
                  Ubah kata sandi
                </button>
              </div>
            </div>
          </section>
        )}

        {current === "reset" && (
          <section className="card">
            <div className="card-head">
              <div className="card-title">
                <h2>Permintaan reset kata sandi</h2>
                <span className="muted small">Dari tombol "Lupa kata sandi" di halaman masuk.</span>
              </div>
            </div>
            {resetRequests.length === 0 ? (
              <div className="card-body empty">
                <h3>Tidak ada permintaan</h3>
                <p>Permintaan reset kata sandi dari pengguna akan muncul di sini.</p>
              </div>
            ) : (
              <div className="table-wrap flush">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="l">Email</th>
                      <th className="l">Diminta</th>
                      <th aria-label="Aksi" />
                    </tr>
                  </thead>
                  <tbody>
                    {resetRequests.map((r) => {
                      const target = users.find((u) => u.email.toLowerCase() === r.email.toLowerCase());
                      return (
                        <tr key={r.id}>
                          <td className="l">{r.email}</td>
                          <td className="l muted">{fmtDateTime(r.created_at)}</td>
                          <td>
                            <div className="row-actions">
                              {target && (
                                <button className="btn small" onClick={() => setResettingUser(target)}>
                                  Reset kata sandi
                                </button>
                              )}
                              <button className="btn ghost small" onClick={() => dismissResetRequest(r.id)}>
                                Tandai selesai
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {current === "pengguna" && (
          <section className="card">
            <div className="card-head">
              <div className="card-title">
                <h2>Pengguna</h2>
                <span className="muted small">{grp(users.length)} pengguna</span>
              </div>
              <button className="btn small primary" onClick={() => setCreating(true)}>
                Tambah pengguna
              </button>
            </div>
            <div className="table-wrap flush">
              <table className="table">
                <thead>
                  <tr>
                    <th className="l">Nama</th>
                    <th className="l">Email</th>
                    <th className="l">Peran</th>
                    <th className="l">Status</th>
                    <th aria-label="Aksi" />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="l">
                        <span className="cell-title">{u.name}</span>
                        {u.id === user?.id && <span className="badge grey rev-badge">Anda</span>}
                      </td>
                      <td className="l muted">{u.email}</td>
                      <td className="l">
                        <select
                          className="cell role-select"
                          aria-label={`Peran ${u.name}`}
                          value={u.role}
                          disabled={u.id === user?.id}
                          onChange={async (e) => {
                            try {
                              await api.patch(`/auth/users/${u.id}`, { role: e.target.value as Role });
                              loadUsers();
                              toast("Peran diperbarui.", "success");
                            } catch (err) {
                              toast(err instanceof Error ? err.message : "Gagal.", "error");
                            }
                          }}
                        >
                          <option value="rep">Sales</option>
                          <option value="manager">Manajer</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td className="l">
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={!!u.active}
                            disabled={u.id === user?.id}
                            aria-label={`Aktifkan ${u.name}`}
                            onChange={async (e) => {
                              try {
                                await api.patch(`/auth/users/${u.id}`, { active: e.target.checked });
                                loadUsers();
                              } catch (err) {
                                toast(err instanceof Error ? err.message : "Gagal.", "error");
                              }
                            }}
                          />
                          <span className={`badge ${u.active ? "green" : "grey"}`}>{u.active ? "Aktif" : "Nonaktif"}</span>
                        </label>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn ghost small"
                            onClick={() => navigate(`/quotes?user_id=${u.id}&user_name=${encodeURIComponent(u.name)}`)}
                          >
                            Lihat quotation
                          </button>
                          {u.id !== user?.id && (
                            <button className="btn ghost small" onClick={() => setResettingUser(u)}>
                              Reset kata sandi
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        </div>
      </div>

      {creating && (
        <NewUserModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            loadUsers();
            toast("Pengguna dibuat.", "success");
          }}
        />
      )}

      {resettingUser && (
        <ResetPasswordModal
          targetUser={resettingUser}
          onClose={() => setResettingUser(null)}
          onDone={() => {
            const resolved = resetRequests.filter(
              (r) => r.email.toLowerCase() === resettingUser.email.toLowerCase(),
            );
            resolved.forEach((r) => dismissResetRequest(r.id));
            setResettingUser(null);
            toast("Kata sandi pengguna direset.", "success");
          }}
        />
      )}
    </main>
  );
}

function ResetPasswordModal({
  targetUser,
  onClose,
  onDone,
}: {
  targetUser: User;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (next !== confirm) {
      toast("Konfirmasi kata sandi tidak cocok.", "error");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/auth/users/${targetUser.id}`, { password: next });
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal mereset kata sandi.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Reset kata sandi — ${targetUser.name}`}
      sub="Sampaikan kata sandi baru ke pengguna, lalu minta mereka menggantinya di menu Pengaturan."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn primary" disabled={next.length < 8 || saving} onClick={submit}>
            {saving ? "Menyimpan…" : "Reset kata sandi"}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field">
          <span>Kata sandi baru (min. 8 karakter)</span>
          <PasswordInput autoComplete="new-password" value={next} onChange={setNext} />
        </label>
        <label className="field">
          <span>Ulangi kata sandi baru</span>
          <PasswordInput autoComplete="new-password" value={confirm} onChange={setConfirm} />
        </label>
      </div>
    </Modal>
  );
}

function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "rep" as Role });

  return (
    <Modal
      title="Tambah pengguna"
      sub="Sampaikan kata sandi awal ke pengguna, lalu minta mereka menggantinya di menu Pengaturan."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button
            className="btn primary"
            disabled={!form.name || !form.email || form.password.length < 8}
            onClick={async () => {
              try {
                await api.post("/auth/users", form);
                onCreated();
              } catch (e) {
                toast(e instanceof Error ? e.message : "Gagal membuat pengguna.", "error");
              }
            }}
          >
            Buat pengguna
          </button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field">
          <span>Nama lengkap</span>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Email kantor</span>
          <input
            className="input" type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Kata sandi awal (min. 8 karakter)</span>
          <PasswordInput
            autoComplete="new-password"
            value={form.password}
            onChange={(v) => setForm({ ...form, password: v })}
          />
        </label>
        <label className="field">
          <span>Peran</span>
          <select
            className="select"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
          >
            <option value="rep">Sales — membuat dan mengajukan quotation sendiri</option>
            <option value="manager">Manajer — menyetujui dan melihat semua quotation</option>
            <option value="admin">Admin — mengatur kebijakan dan pengguna</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}
