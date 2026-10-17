import { Link } from 'react-router-dom';
import { CaveSwitcher } from './CaveSwitcher';
import { Icon } from './Icon';

export function TopBar({ title, back }: { title?: string; back?: string }) {
  return (
    <header className="topbar">
      {back ? (
        <Link to={back} aria-label="Retour" className="topbar__back">
          <Icon name="arrow_back" />
        </Link>
      ) : (
        <img src="/icons/icon.svg" alt="" className="topbar__logo" width={32} height={32} />
      )}
      <h1 className="topbar__title">{title ?? 'Ma Cave'}</h1>
      <CaveSwitcher />
      {/* Mon compte : installation, caves, sauvegarde, version, déconnexion. */}
      <Link to="/compte" aria-label="Mon compte" className="topbar__account">
        <Icon name="account_circle" />
      </Link>
    </header>
  );
}
