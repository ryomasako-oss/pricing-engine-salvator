/* Riwayat: one item in the top menu (Ryoma, 10 Nov), and these tabs on each history page to move
   between them. The pages themselves are unchanged. */

import { NavLink } from "react-router-dom";

export const HISTORY_TABS = [
  { to: "/cogs-history", label: "COGS", title: "Riwayat COGS" },
  { to: "/sales-history", label: "Penjualan (SI)", title: "Riwayat penjualan (SI)" },
  { to: "/purchase-history", label: "Pembelian (PI)", title: "Riwayat pembelian (PI)" },
] as const;

export const isHistoryPath = (pathname: string) => HISTORY_TABS.some((t) => pathname.startsWith(t.to));

export function HistoryTabs() {
  return (
    <nav className="tabs history-tabs" aria-label="Jenis riwayat">
      {HISTORY_TABS.map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? "on" : "")} title={t.title}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
