import { NavLink } from 'react-router-dom';
import { useCurrentCave } from '../lib/use-current-cave';
import { Icon } from './Icon';

const tabs = [
  { to: '/cave', icon: 'shelves', label: 'Cave', soon: false, ownerOnly: false },
  { to: '/entree', icon: 'add_circle', label: 'Entrée', soon: false, ownerOnly: true },
  { to: '/sortie', icon: 'remove_circle_outline', label: 'Sortie', soon: false, ownerOnly: true },
  { to: '/journal', icon: 'history_edu', label: 'Journal', soon: false, ownerOnly: true },
  { to: '/stats', icon: 'bar_chart', label: 'Stats', soon: false, ownerOnly: false },
];

export function BottomNav() {
  // Un membre en lecture seule n'a ni entrée, ni sortie, ni journal.
  const { isOwner } = useCurrentCave();
  return (
    <nav className="bottomnav" aria-label="Navigation principale">
      {tabs.filter((t) => isOwner || !t.ownerOnly).map((t) =>
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
