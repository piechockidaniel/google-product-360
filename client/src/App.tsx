import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { LanguageSwitcher, useT } from './lib/i18n';
import { Badge, Spinner } from './components/ui';
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

const NAV = [
  { to: '/', key: 'nav.dashboard', icon: '▦', end: true },
  { to: '/products', key: 'nav.products', icon: '▤' },
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

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">{t('app.name')}</div>
          <div className="brand-sub">
            {accountId ? t('nav.account', { id: accountId }) : ''}
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
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
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
