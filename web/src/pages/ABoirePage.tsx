import { Link } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { TopBar } from '../components/TopBar';
import { apogeeShortLabel } from '../lib/apogee';
import { groupByPlace, useDrinkSoon } from '../lib/drink-soon';

/** À boire prochainement, regroupé par emplacement : où descendre chercher les bouteilles. */
export function ABoirePage() {
  const soon = useDrinkSoon();
  const groups = soon.data ? groupByPlace(soon.data) : [];
  return (
    <>
      <TopBar title="À boire prochainement" back="/" />
      <main className="page">
        <p className="list__meta">Vins dont l’apogée se termine au plus tard l’an prochain, rangés par emplacement.</p>
        {soon.isError && <p role="alert" className="text-error">{(soon.error as Error).message}</p>}
        {soon.data?.length === 0 && <p className="centered">Rien d’urgent à boire.</p>}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h2 style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)' }}>{g.label.toUpperCase()}</h2>
            <div className="list">
              {g.wines.map(({ wine: w, quantity }) => (
                <Link key={w.id} to={`/cave/${w.id}`} className="cave-row">
                  <span style={{ minWidth: 0 }}>
                    <span className="list__title" style={{ display: 'block' }}>
                      {w.producer}{w.cuvee ? ` — ${w.cuvee}` : ''} {w.vintage ?? 'NV'}
                    </span>
                    {w.apogee && <span className="list__meta">{apogeeShortLabel(w.apogee)}</span>}
                  </span>
                  <span className="cave-row__qty num">{quantity}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </main>
      <BottomNav />
    </>
  );
}
