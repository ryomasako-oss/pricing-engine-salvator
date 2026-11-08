import { lazy, Suspense } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { useTheme } from "./context/ThemeContext";
import { useConfirmLeave } from "./context/UnsavedGuardContext";
import { Icon } from "./components/Icon";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { ChatProvider } from "./context/ChatContext";
import { NavCountsProvider, useNavCounts } from "./context/NavCountsContext";
import { ChatDock } from "./components/ChatDock";
import type { Permission } from "@shared/permissions";

// Pages other than the quote list load on first visit, so the PDF, Excel and
// OCR libraries they pull in stay out of the bundle every login downloads.
// A tab left open across a deploy is handled by the preload-error reload in main.tsx.
const QuoteEditorPage = lazy(() => import("./pages/QuoteEditor").then((m) => ({ default: m.QuoteEditorPage })));
const StaffQuotePage = lazy(() => import("./pages/StaffQuote").then((m) => ({ default: m.StaffQuotePage })));
const ApprovalsPage = lazy(() => import("./pages/Approvals").then((m) => ({ default: m.ApprovalsPage })));
const CatalogPage = lazy(() => import("./pages/Catalog").then((m) => ({ default: m.CatalogPage })));
const ClientsPage = lazy(() => import("./pages/Clients").then((m) => ({ default: m.ClientsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const FixTasksPage = lazy(() => import("./pages/FixTasks").then((m) => ({ default: m.FixTasksPage })));
const MatchingPage = lazy(() => import("./pages/Matching").then((m) => ({ default: m.MatchingPage })));
const CogsHistoryPage = lazy(() => import("./pages/CogsHistory").then((m) => ({ default: m.CogsHistoryPage })));
const SalesHistoryPage = lazy(() => import("./pages/SalesHistory").then((m) => ({ default: m.SalesHistoryPage })));

function PageLoading() {
  return (
    <div className="hk-main">
      <div className="loading" role="status">
        <span className="dots"><i /><i /><i /></span>
        Memuat…
      </div>
    </div>
  );
}

function TopBar() {
  const { user, logout, can } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { pending, toFix } = useNavCounts();
  const confirmLeave = useConfirmLeave();

  const guardedClick = (e: React.MouseEvent) => {
    if (!confirmLeave()) e.preventDefault();
  };

  return (
    <header className="hk-top">
      <NavLink to="/" className="hk-brand" onClick={guardedClick}>
        <span className="hk-logo" aria-hidden="true">h</span>
        <span>
          <span className="hk-title" style={{ display: "block" }}>Pricing Engine Salvator</span>
          <span className="hk-sub">PT Salvator Inti Pratama</span>
        </span>
      </NavLink>

      <nav className="hk-nav" aria-label="Navigasi utama">
        <NavLink to="/quotes" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
          <Icon name="quote" size={16} />
          <span className="label">Quotation</span>
        </NavLink>
        <NavLink to="/pencocokan" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
          <Icon name="search" size={16} />
          <span className="label">Pencocokan</span>
        </NavLink>
        {can("decide_quotes") && (
          <NavLink to="/approvals" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
            <Icon name="shield" size={16} />
            <span className="label">Persetujuan</span>
            {!!pending && <span className="count">{pending}</span>}
          </NavLink>
        )}
        <NavLink to="/perbaikan" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
          <Icon name="alert" size={16} />
          <span className="label">Perbaikan</span>
          {!!toFix && <span className="count" aria-label={`${toFix} perlu diperbaiki`}>{toFix}</span>}
        </NavLink>
        <NavLink to="/catalog" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
          <Icon name="box" size={16} />
          <span className="label">Katalog</span>
        </NavLink>
        {can("view_costs") && (
          <>
            <NavLink to="/cogs-history" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
              <Icon name="history" size={16} />
              <span className="label">Riwayat COGS</span>
            </NavLink>
            <NavLink to="/sales-history" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
              <Icon name="doc" size={16} />
              <span className="label">Riwayat SI</span>
            </NavLink>
          </>
        )}
        <NavLink to="/clients" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
          <Icon name="building" size={16} />
          <span className="label">Klien</span>
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")} onClick={guardedClick}>
          <Icon name="gear" size={16} />
          <span className="label">Pengaturan</span>
        </NavLink>
      </nav>

      <div className="row">
        <span className="muted small hide-sm">
          {user?.name}
          <span className="badge grey" style={{ marginLeft: 6 }}>
            {user?.role === "admin" ? "Admin" : user?.role === "manager" ? "Manajer" : "Sales"}
          </span>
        </span>
        <button
          className="icon-btn"
          onClick={toggleTheme}
          title={theme === "dark" ? "Mode terang" : "Mode gelap"}
          aria-label={theme === "dark" ? "Mode terang" : "Mode gelap"}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={() => confirmLeave() && void logout()}
          title="Keluar"
          aria-label="Keluar"
        >
          <Icon name="logout" size={17} />
        </button>
      </div>
    </header>
  );
}

function RequirePermission({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="hk-main">
        <div className="card">
          <div className="card-body empty">
            <Icon name="shield" size={28} />
            <h3>Halaman ini khusus manajer dan admin</h3>
            <p>Akun Anda tidak punya akses ke bagian ini.</p>
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function App() {
  const { user, loading, can } = useAuth();
  const { pathname } = useLocation();

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="loading">
          <span className="dots"><i /><i /><i /></span>
          Memuat…
        </div>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <ChatProvider>
    <NavCountsProvider>
    <div className="hk-app">
      <TopBar />
      <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/quotes" replace />} />
        <Route path="/quotes" element={<DashboardPage />} />
        {/* Staff get a screen without cost data; the server sends them none (PE-1). */}
        <Route path="/quotes/:id" element={can("view_costs") ? <QuoteEditorPage /> : <StaffQuotePage />} />
        <Route
          path="/approvals"
          element={
            <RequirePermission permission="decide_quotes">
              <ApprovalsPage />
            </RequirePermission>
          }
        />
        <Route path="/perbaikan" element={<FixTasksPage />} />
        <Route path="/pencocokan" element={<MatchingPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route
          path="/cogs-history"
          element={
            <RequirePermission permission="view_costs">
              <CogsHistoryPage />
            </RequirePermission>
          }
        />
        <Route
          path="/sales-history"
          element={
            <RequirePermission permission="view_costs">
              <SalesHistoryPage />
            </RequirePermission>
          }
        />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/quotes" replace />} />
      </Routes>
      </Suspense>
      {/* The quotation editor has Silvy docked in its side column; a second round
          button there would cover the panel's composer. Staff get no panel, so they keep it. */}
      {!(can("view_costs") && /^\/quotes\/\d+/.test(pathname)) && <ChatDock />}
    </div>
    </NavCountsProvider>
    </ChatProvider>
  );
}
