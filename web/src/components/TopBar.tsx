import { Link } from 'react-router-dom';
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
    </header>
  );
}
