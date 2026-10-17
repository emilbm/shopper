import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, LOGGED_OUT_EVENT } from './api';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { IconBook, IconCalendar, IconCart, IconList, IconPot, IconTag } from './components/ui';
import { isTyping } from './keys';
import { useLiveSync } from './live';
import { lastMode, rememberMode } from './mode';
import CookDinnerPage from './pages/CookDinnerPage';
import CookPage from './pages/CookPage';
import ItemsPage from './pages/ItemsPage';
import ListEditPage from './pages/ListEditPage';
import ListsPage from './pages/ListsPage';
import LoginPage from './pages/LoginPage';
import NemligPage from './pages/NemligPage';
import PlanPage from './pages/PlanPage';
import PlansPage from './pages/PlansPage';
import RecipeEditPage from './pages/RecipeEditPage';
import RecipeImportPage from './pages/RecipeImportPage';
import RecipePage from './pages/RecipePage';
import RecipesPage from './pages/RecipesPage';
import ShopPage from './pages/ShopPage';
import { useShop } from './queries';
import { useWide } from './useWide';

const TABS = [
  { to: '/shop', label: 'Shop', icon: IconCart, key: 's' },
  { to: '/plan', label: 'Plan', icon: IconCalendar, key: 'p' },
  { to: '/recipes', label: 'Recipes', icon: IconBook, key: 'r' },
  { to: '/lists', label: 'Lists', icon: IconList, key: 'l' },
  { to: '/items', label: 'Items', icon: IconTag, key: 'i' },
];

/** The bare address opens whichever side this device used last. */
function Home() {
  const wide = useWide();
  return <Navigate to={`/${lastMode() ?? (wide ? 'shop' : 'cook')}`} replace />;
}

/**
 * With a password set on the server, nothing but the login page is shown
 * until this browser has logged in. A refusal later on — the password or the
 * login generation changed — brings the login page back.
 */
export default function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, staleTime: Infinity, retry: false });

  useEffect(() => {
    const recheck = () => void qc.invalidateQueries({ queryKey: ['session'] });
    window.addEventListener(LOGGED_OUT_EVENT, recheck);
    return () => window.removeEventListener(LOGGED_OUT_EVENT, recheck);
  }, [qc]);

  if (session.isLoading) return null;
  if (session.data?.required && !session.data.authenticated) return <LoginPage />;
  return <Signed loginRequired={!!session.data?.required} />;
}

/** The app itself, for a browser that may use it. */
function Signed({ loginRequired }: { loginRequired: boolean }) {
  const { pathname } = useLocation();
  const cooking = pathname.startsWith('/cook');
  useLiveSync();

  useEffect(() => {
    if (pathname !== '/') rememberMode(cooking ? 'cook' : 'shop');
  }, [pathname, cooking]);

  // Cook is its own small app for a phone by the stove: no tabs, no sidebar.
  if (cooking) {
    return (
      <div className="app app--cook">
        <Routes>
          <Route path="/cook" element={<CookPage />} />
          <Route path="/cook/:id" element={<CookDinnerPage />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="app">
      <ShopNav loginRequired={loginRequired} />
      <div className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/shop" element={<ShopPage />} />
          <Route path="/shop/nemlig" element={<NemligPage />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/recipes" element={<RecipesPage />} />
          <Route path="/recipes/new" element={<RecipeEditPage />} />
          <Route path="/recipes/import" element={<RecipeImportPage />} />
          <Route path="/recipes/:id" element={<RecipePage />} />
          <Route path="/recipes/:id/edit" element={<RecipeEditPage />} />
          <Route path="/lists" element={<ListsPage />} />
          <Route path="/lists/new" element={<ListEditPage />} />
          <Route path="/lists/:id" element={<ListEditPage />} />
          <Route path="/items" element={<ItemsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function ShopNav({ loginRequired }: { loginRequired: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const shop = useShop();
  const toGet = shop.data?.lines.filter((l) => !l.checked).length ?? 0;

  // g then a letter, as in Gmail: g s shop, g p plan, g r recipes, g l lists, g i items, g c cook.
  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (pending) {
        pending = false;
        const key = e.key.toLowerCase();
        if (key === 'c') navigate('/cook');
        const tab = TABS.find((t) => t.key === key);
        if (tab) navigate(tab.to);
        return;
      }
      if (e.key === 'g') {
        pending = true;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = false), 1200);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [navigate]);

  return (
    <nav className="nav">
      <div className="nav__brand">
        <img src="/icon.svg" alt="" width={28} height={28} />
        <span>Grocer</span>
      </div>
      {TABS.map(({ to, label, icon: Icon, key }) => (
        <NavLink key={to} to={to} title={`${label} (g ${key})`}>
          <Icon />
          <span>{label}</span>
          {to === '/shop' && toGet > 0 && <span className="nav__count num">{toGet}</span>}
        </NavLink>
      ))}
      <NavLink to="/cook" className="nav__cook" title="Cook — this week's dinners (g c)">
        <IconPot />
        <span>Cook</span>
      </NavLink>
      <div className="nav__hint">
        <kbd>/</kbd> add to the list · <kbd>g</kbd> <kbd>r</kbd> recipes
        {loginRequired && (
          <>
            {' · '}
            <button
              className="linkish"
              onClick={() => void api.logout().then(() => qc.invalidateQueries({ queryKey: ['session'] }))}
            >
              Log out
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
