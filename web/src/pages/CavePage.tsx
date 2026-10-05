import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { TopBar } from '../components/TopBar';
import { WineThumb } from '../components/WineThumb';
import { CaveFilter, getCave, WineColor } from '../lib/api-client';
import { apogeeShortLabel } from '../lib/apogee';
import { formatRatingShort } from '../lib/rating';

const COLORS: Array<{ value: WineColor | ''; label: string }> = [
  { value: '', label: 'Toutes' }, { value: 'ROUGE', label: 'Rouge' }, { value: 'BLANC', label: 'Blanc' },
  { value: 'ROSE', label: 'Rosé' }, { value: 'PETILLANT', label: 'Pétillant' },
];

/** Filtre d'apogée demandé par un lien (page Statistiques) : `?filtre=priorite` ou `?filtre=sans-apogee`. */
const FILTER_FROM_URL: Record<string, 'drinkSoon' | 'noApogee'> = { priorite: 'drinkSoon', 'sans-apogee': 'noApogee' };

export function CavePage() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [color, setColor] = useState<WineColor | ''>('');
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [dish, setDish] = useState('');
  // Un seul filtre d'apogée à la fois : « à boire en priorité » exclut par définition les vins sans estimation.
  const [apogeeFilter, setApogeeFilter] = useState<'' | 'drinkSoon' | 'noApogee'>(FILTER_FROM_URL[params.get('filtre') ?? ''] ?? '');
  const base: CaveFilter = { q, color: color || undefined, includeEmpty, ...(dish.trim() ? { dish: dish.trim() } : {}) };
  const filter: CaveFilter = apogeeFilter ? { ...base, [apogeeFilter]: true } : base;
  const cave = useQuery({ queryKey: ['cave', filter], queryFn: () => getCave(filter) });
  // Avec « à boire en priorité », les vins sans estimation ne sont pas oubliés : on les compte à part.
  const missingFilter: CaveFilter = { ...base, noApogee: true };
  const missing = useQuery({
    queryKey: ['cave', missingFilter],
    queryFn: () => getCave(missingFilter),
    enabled: apogeeFilter === 'drinkSoon',
  });
  const missingCount = apogeeFilter === 'drinkSoon' ? missing.data?.length ?? 0 : 0;
  const toggle = (which: 'drinkSoon' | 'noApogee') => (checked: boolean) => setApogeeFilter(checked ? which : '');

  return (
    <>
      <TopBar title="La cave" />
      <main className="page">
        <section className="cave-filters">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Domaine, cuvée, appellation…" aria-label="Rechercher" />
          <input type="search" value={dish} onChange={(e) => setDish(e.target.value)} placeholder="Agneau, comté, poisson…" aria-label="Accompagner un plat" maxLength={100} />
          {/* Libellé relié par htmlFor : enveloppé dans le <label>, le select aurait
              pour nom accessible « Couleur » suivi du texte de toutes ses options. */}
          <label htmlFor="cave-color" className="field__label">Couleur</label>
          <select id="cave-color" value={color} onChange={(e) => setColor(e.target.value as WineColor | '')}>
            {COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <label className="field__label">
            <input type="checkbox" checked={includeEmpty} onChange={(e) => setIncludeEmpty(e.target.checked)} aria-label="Afficher les vins épuisés" />
            Vins épuisés
          </label>
          <label className="field__label">
            <input type="checkbox" checked={apogeeFilter === 'drinkSoon'} onChange={(e) => toggle('drinkSoon')(e.target.checked)} aria-label="À boire en priorité" />
            À boire en priorité
          </label>
          <label className="field__label">
            <input type="checkbox" checked={apogeeFilter === 'noApogee'} onChange={(e) => toggle('noApogee')(e.target.checked)} aria-label="Sans apogée" />
            Sans apogée
          </label>
        </section>
        {apogeeFilter === 'drinkSoon' && missing.isError && (
          <p role="alert" className="text-error">Impossible de compter les vins sans apogée.</p>
        )}
        {missingCount > 0 && (
          <aside className="banner" role="status">
            <span>{`${missingCount} ${missingCount > 1 ? 'vins' : 'vin'} sans apogée estimée`}</span>
            <button type="button" className="btn btn--outline" onClick={() => setApogeeFilter('noApogee')}>À compléter</button>
          </aside>
        )}
        {cave.isError && <p role="alert" className="text-error">Impossible de charger la cave.</p>}
        {cave.data?.length === 0 && <p className="centered">Aucun vin ne correspond.</p>}
        <div className="list">
          {cave.data?.map((w) => (
            <Link key={w.id} to={`/cave/${w.id}`} className="cave-row" style={{ opacity: w.quantity > 0 ? 1 : 0.55 }}>
              <WineThumb photoId={w.referencePhotoId} size={44} />
              <span style={{ minWidth: 0 }}>
                <span className="list__title" style={{ display: 'block' }}>
                  {w.producer}{w.cuvee ? ` — ${w.cuvee}` : ''} {w.vintage ?? 'NV'}
                </span>
                <span className="list__meta">{w.appellationRaw} · {COLORS.find((c) => c.value === w.color)?.label}</span>
                {w.apogee && apogeeShortLabel(w.apogee) && (
                  <span className="list__meta" style={{ display: 'block' }}>{apogeeShortLabel(w.apogee)}</span>
                )}
                {w.rating && <span className="list__meta num" style={{ display: 'block' }}>{formatRatingShort(w.rating.value)}</span>}
                {w.matchedDish && <span className="list__meta" style={{ display: 'block' }}>{`avec : ${w.matchedDish}`}</span>}
              </span>
              <span className="cave-row__qty num">{w.quantity}</span>
            </Link>
          ))}
        </div>
      </main>
      <BottomNav />
    </>
  );
}
