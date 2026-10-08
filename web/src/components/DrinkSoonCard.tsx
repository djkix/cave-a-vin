import { Link } from 'react-router-dom';
import { apogeeShortLabel } from '../lib/apogee';
import { useDrinkSoon, whereLabel } from '../lib/drink-soon';

const SHOWN = 3;

/** Accueil : les vins les plus urgents à boire, avec l'endroit où ils sont rangés. */
export function DrinkSoonCard() {
  const soon = useDrinkSoon();
  if (!soon.data) return null;
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>À boire prochainement</h2>
      {soon.data.length === 0 ? (
        <p className="list__meta">Rien d’urgent à boire.</p>
      ) : (
        <>
          <div className="list">
            {soon.data.slice(0, SHOWN).map((w) => (
              <Link key={w.id} to={`/cave/${w.id}`} className="list__row" style={{ display: 'block' }}>
                <span className="list__title" style={{ display: 'block' }}>
                  {w.producer}{w.cuvee ? ` — ${w.cuvee}` : ''} {w.vintage ?? 'NV'}
                </span>
                <span className="list__meta">{[w.apogee && apogeeShortLabel(w.apogee), whereLabel(w)].filter(Boolean).join(' · ')}</span>
              </Link>
            ))}
          </div>
          <Link to="/a-boire" className="btn btn--link">Tout voir ({soon.data.length})</Link>
        </>
      )}
    </section>
  );
}
