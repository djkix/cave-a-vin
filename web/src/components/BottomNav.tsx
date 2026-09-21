import { NavLink } from 'react-router-dom';
import { Icon } from './Icon';

const tabs = [
  { to: '/cave', icon: 'shelves', label: 'Cave', soon: true },
  { to: '/entree', icon: 'add_circle', label: 'Entrée', soon: false },
  { to: '/sortie', icon: 'remove_circle_outline', label: 'Sortie', soon: true },
  { to: '/journal', icon: 'history_edu', label: 'Journal', soon: false },
];

export function BottomNav() {
  return (
    <nav className="bottomnav" aria-label="Navigation principale">
      {tabs.map((t) =>
        t.soon ? (
          <span key={t.to} className="bottomnav__tab bottomnav__tab--soon" aria-disabled="true" title="Bientôt disponible">
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </span>
        ) : (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => `bottomnav__tab${isActive ? ' bottomnav__tab--active' : ''}`}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </NavLink>
        ),
      )}
    </nav>
  );
}
