import { Link } from 'react-router-dom';
import { APP_VERSION } from '../lib/version';
import { Icon } from './Icon';

export function TopBar({ title, back }: { title?: string; back?: string }) {
  return (
    <header className="topbar">
      {back ? (
        <Link to={back} aria-label="Retour" className="topbar__back">
          <Icon name="arrow_back" />
        </Link>
      ) : (
        <Icon name="wine_bar" className="topbar__logo" />
      )}
      <h1 className="topbar__title">{title ?? 'Cave & Terroir'}</h1>
      {/* La barre de titre est présente sur tous les écrans : c'est le seul
          endroit où la version est visible en permanence, y compris depuis la
          PWA installée, où aucune barre d'adresse ne dit ce qui tourne. */}
      <span className="topbar__version" aria-label={`Version ${APP_VERSION}`}>
        v{APP_VERSION}
      </span>
    </header>
  );
}
