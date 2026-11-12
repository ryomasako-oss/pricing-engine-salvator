/* Riwayat: one item in the top menu (Ryoma, 10 Nov), and these tabs on each history page to move
   between them. The pages themselves are unchanged. */

import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import type { Permission } from "@shared/permissions";

export const HISTORY_TABS: { to: string; label: string; title: string; permission: Permission }[] = [
  { to: "/cogs-history", label: "COGS", title: "Riwayat COGS", permission: "view_costs" },
  { to: "/sales-history", label: "Penjualan (SI)", title: "Riwayat penjualan (SI)", permission: "view_costs" },
  { to: "/purchase-history", label: "Pembelian (PI)", title: "Riwayat pembelian (PI)", permission: "view_costs" },
  { to: "/below-cost", label: "Jual < Beli", title: "SI yang dijual di bawah harga PI", permission: "view_costs" },
  { to: "/audit", label: "Audit", title: "Riwayat audit: siapa melakukan apa", permission: "view_audit" },
];

export const isHistoryPath = (pathname: string) => HISTORY_TABS.some((t) => pathname.startsWith(t.to));

export function HistoryTabs() {
  const { can } = useAuth();
  return (
    <nav className="tabs history-tabs" aria-label="Jenis riwayat">
      {HISTORY_TABS.filter((t) => can(t.permission)).map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? "on" : "")} title={t.title}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
