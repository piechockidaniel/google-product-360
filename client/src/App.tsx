import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { LanguageSwitcher, useT } from './lib/i18n';
import { Badge, HealthDot, Spinner } from './components/ui';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProductsPage from './pages/ProductsPage';
import ProductDetailPage from './pages/ProductDetailPage';
import IssuesPage from './pages/IssuesPage';
import FeedsPage from './pages/FeedsPage';
import WorkflowsPage from './pages/WorkflowsPage';
import WorkflowEditorPage from './pages/WorkflowEditorPage';
import ActivityPage from './pages/ActivityPage';
import MarketPage from './pages/MarketPage';
import SettingsPage from './pages/SettingsPage';
import SetupWizardPage from './pages/SetupWizardPage';
import WooCommercePage from './pages/WooCommercePage';
import AllegroPage from './pages/AllegroPage';

const NAV = [
  { to: '/', key: 'nav.dashboard', icon: '▦', end: true },
  { to: '/products', key: 'nav.products', icon: '▤' },
  { to: '/woocommerce', key: 'nav.woocommerce', icon: '▣' },
  { to: '/allegro', key: 'nav.allegro', icon: '▥' },
  { to: '/issues', key: 'nav.issues', icon: '⚠' },
  { to: '/market', key: 'nav.market', icon: '◔' },
  { to: '/feeds', key: 'nav.feeds', icon: '⇅' },
  { to: '/workflows', key: 'nav.workflows', icon: '⚙' },
  { to: '/activity', key: 'nav.activity', icon: '≡' },
  { to: '/settings', key: 'nav.settings', icon: '☰' },
] as const;

export default function App() {
  const { user, loading, logout, mock, accountId, configured, needsAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();

  if (loading) return <Spinner />;

  // First start: nobody can log in yet -> the wizard creates the administrator.
  if (needsAdmin && !user) return <SetupWizardPage />;

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  // Logged in but the Merchant Center connection is missing -> wizard (settings stay reachable).
  if (!configured && location.pathname !== '/setup' && location.pathname !== '/settings') {
    return <Navigate to="/setup" replace />;
  }
  if (location.pathname === '/setup') return <SetupWizardPage />;

  const activeNav = NAV.find((item) => ('end' in item && item.end ? location.pathname === item.to : location.pathname.startsWith(item.to))) ?? NAV[0];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-lockup">
            <span className="brand-mark">360</span>
            <div>
              <div className="brand-title">
                Product<span>360</span>
              </div>
              <div className="brand-subtitle">{t('app.name')}</div>
            </div>
          </div>
          <div className="brand-sub">
            {accountId ? t('nav.account', { id: accountId }) : t('app.tagline')}
            {mock && (
              <Badge tone="warning" title={t('common.mockTitle')}>
                {t('common.mock')}
              </Badge>
            )}
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n && n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-icon">{n.icon}</span>
              {t(n.key)}
              {n.to === '/settings' && !configured && <span className="dot dot-error nav-dot" title={t('nav.notConfigured')} />}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="muted">{user.username}</div>
          <LanguageSwitcher compact />
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await logout();
              navigate('/');
            }}
          >
            {t('common.logout')}
          </button>
        </div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span className="muted">{t('app.name')}</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{t(activeNav.key)}</strong>
          </div>
          <div className="topbar-actions">
            <div className="connection-pill">
              <HealthDot health={configured ? 'ok' : 'warning'} />
              <span>{configured ? t('app.liveSynced') : t('app.setupRequired')}</span>
            </div>
            {accountId && <span className="topbar-account">{accountId}</span>}
            <LanguageSwitcher compact />
            <div className="user-chip" title={user.username}>
              <span className="user-avatar">{user.username.slice(0, 2).toUpperCase()}</span>
              <span className="user-name">{user.username}</span>
            </div>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/woocommerce" element={<WooCommercePage />} />
          <Route path="/allegro" element={<AllegroPage />} />
          <Route path="/issues" element={<IssuesPage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/feeds" element={<FeedsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/new" element={<WorkflowEditorPage />} />
          <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
