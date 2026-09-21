import { Link } from 'react-router-dom';

export function TopBar({ title, back }: { title?: string; back?: string }) {
  return (
    <header className="topbar">
      {back ? (
        <Link to={back} aria-label="Retour" className="topbar__back">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
      ) : (
        <span className="material-symbols-outlined topbar__logo">wine_bar</span>
      )}
      <h1 className="topbar__title">{title ?? 'Cave & Terroir'}</h1>
    </header>
  );
}
