import { useEffect, useState } from "react";
import { useNavCounts } from "../context/NavCountsContext";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { Icon } from "./Icon";

/* "Perlu tindakan": the next steps of the signed-in role's own flow
   (docs/ui-standar.md, "Tampilan per peran"). Sales: finish drafts, fix
   rejected quotes, send approved ones. Manager: decide, then fix. Admin: the
   manager's tiles plus password resets. Counts come from the same endpoints
   the top bar badges (NavCountsContext); only the admin's reset count is extra. */

export interface StatusCounts {
  draft: number;
  rejected: number;
  approved: number;
  submitted: number;
}

interface Tile {
  key: string;
  label: string;
  foot: string;
  n: number | null;
  icon: string;
  /** A route, or a status tab on this page. */
  to?: string;
  tab?: string;
  tone: "warn" | "err" | "info";
}

export function RoleTasks({ counts, onTab }: { counts: StatusCounts; onTab: (status: string) => void }) {
  const { can } = useAuth();
  const manager = can("decide_quotes");
  const admin = can("manage_users");
  const { pending: approvals, toFix: fixes } = useNavCounts();
  const [resets, setResets] = useState<number | null>(null);

  useEffect(() => {
    if (admin) {
      api
        .get<{ requests: unknown[] }>("/auth/password-reset-requests")
        .then((r) => setResets(r.requests.length))
        .catch(() => undefined);
    }
  }, [admin]);

  const fixTile: Tile = {
    key: "fix", label: "Perlu diperbaiki", n: fixes, icon: "alert", to: "/perbaikan", tone: "err",
    foot: manager ? "Barang tanpa COGS, satuan, katalog" : "Barang di quotation Anda",
  };
  const tiles: Tile[] = manager
    ? [
        {
          key: "approvals", label: "Menunggu keputusan Anda", n: approvals, icon: "shield", to: "/approvals", tone: "warn",
          foot: "Melanggar kebijakan harga",
        },
        fixTile,
        {
          key: "approved", label: "Disetujui, belum dikirim", n: counts.approved, icon: "check", tab: "approved", tone: "info",
          foot: "Ingatkan sales untuk mengirim",
        },
        ...(admin
          ? [{
              key: "resets", label: "Permintaan reset sandi", n: resets, icon: "users", to: "/settings?bagian=reset", tone: "warn",
              foot: "Di Pengaturan, Permintaan reset",
            } satisfies Tile]
          : []),
      ]
    : [
        {
          key: "draft", label: "Draft belum diajukan", n: counts.draft, icon: "quote", tab: "draft", tone: "info",
          foot: "Lengkapi lalu ajukan",
        },
        {
          key: "rejected", label: "Ditolak, perlu revisi", n: counts.rejected, icon: "x", tab: "rejected", tone: "err",
          foot: "Baca catatan manajer",
        },
        fixTile,
        {
          key: "approved", label: "Disetujui, siap dikirim", n: counts.approved, icon: "check", tab: "approved", tone: "info",
          foot: "Ekspor PDF lalu tandai terkirim",
        },
        {
          key: "submitted", label: "Menunggu manajer", n: counts.submitted, icon: "clock", tab: "submitted", tone: "warn",
          foot: "Tidak perlu tindakan",
        },
      ];

  return (
    <section aria-label="Perlu tindakan">
      <h2 className="section-title">Perlu tindakan</h2>
      <div className="task-grid">
        {tiles.map((t) => {
          const body = (
            <>
              <span className="label"><Icon name={t.icon} size={14} /> {t.label}</span>
              <span className="value num">{t.n ?? "–"}</span>
              <span className="foot">{t.foot}</span>
            </>
          );
          const cls = `task-tile${t.n ? ` has-${t.tone}` : ""}`;
          return t.to ? (
            <Link key={t.key} to={t.to} className={cls}>{body}</Link>
          ) : (
            <button key={t.key} type="button" className={cls} onClick={() => onTab(t.tab!)}>{body}</button>
          );
        })}
      </div>
    </section>
  );
}
