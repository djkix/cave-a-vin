import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { TopBar } from '../components/TopBar';
import { BarList, BarRow } from '../components/stats/BarList';
import { MonthlyChart } from '../components/stats/MonthlyChart';
import { getStats, Stats, StatsRankedWine, StatsShare } from '../lib/api-client';
import { CESSION_NOTE, formatEurosRounded } from '../lib/quote';
import { formatRatingShort } from '../lib/rating';

const COLOR_LABEL: Record<string, string> = { ROUGE: 'Rouge', BLANC: 'Blanc', ROSE: 'Rosé', PETILLANT: 'Pétillant' };
const COLOR_VAR: Record<string, string> = {
  ROUGE: 'var(--color-wine-rouge)', BLANC: 'var(--color-wine-blanc)', ROSE: 'var(--color-wine-rose)', PETILLANT: 'var(--color-wine-petillant)',
};
const APOGEE_LABEL: Record<string, string> = {
  TROP_JEUNE: 'Trop jeune', A_BOIRE: 'À boire', A_BOIRE_VITE: 'À boire vite', PASSEE: 'Passée', SANS_ESTIMATION: 'Sans estimation',
};
const APOGEE_LINK: Record<string, string> = {
  A_BOIRE_VITE: '/cave?filtre=priorite', PASSEE: '/cave?filtre=priorite', SANS_ESTIMATION: '/cave?filtre=sans-apogee',
};
const REGIONS_SHOWN = 8;

const EUROS = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const euros = (cents: number) => `~${EUROS.format(Math.round(cents / 100))} €`;
const wineLabel = (w: StatsRankedWine) => `${w.producer}${w.cuvee ? ` — ${w.cuvee}` : ''} ${w.vintage ?? 'NV'}`;
const quotedText = (n: number) => `${n} ${n > 1 ? 'références cotées' : 'référence cotée'}`;

/** Valeur à la cote, propriétaire seulement : un membre ne reçoit pas les clés et rien n'est rendu. */
function QuotedValue({ s }: { s: Stats }) {
  if (!('quotedValueCents' in s)) return null;
  const value = s.quotedValueCents ?? null;
  return (
    <section className="card">
      {value == null ? (
        <>
          <p style={{ margin: 0 }}>Valeur à la cote : —</p>
          <p className="list__meta" style={{ margin: 0 }}>Pas encore de cote</p>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>{`Valeur à la cote : ${formatEurosRounded(value)} sur ${quotedText(s.quotedReferences ?? 0)} (sur ${s.quotableReferences ?? 0})`}</p>
          {s.cessionValueCents != null && (
            <p className="list__meta" style={{ margin: 0 }}>{`Valeur de cession estimée : ${formatEurosRounded(s.cessionValueCents)} ${CESSION_NOTE}`}</p>
          )}
        </>
      )}
    </section>
  );
}

const bottlesText = (n: number) => `${n} ${n > 1 ? 'bouteilles' : 'bouteille'}`;

/** Les `count` premières, puis une ligne « Autres » qui totalise le reste. */
function topWithOthers(rows: StatsShare[], count: number): StatsShare[] {
  if (rows.length <= count) return rows;
  const rest = rows.slice(count);
  return [...rows.slice(0, count), {
    key: 'Autres', bottles: rest.reduce((s, r) => s + r.bottles, 0), share: rest.reduce((s, r) => s + r.share, 0),
  }];
}

const plain = (rows: StatsShare[]): BarRow[] => rows.map((r) => ({ ...r, label: r.key }));

function RankList({ title, items }: { title: string; items: Array<{ key: string; label: string; value: string; to?: string }> }) {
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>{title}</h2>
      {items.length === 0 && <p className="list__meta">Rien à classer pour l’instant.</p>}
      <ol className="bars">
        {items.map((i) => (
          <li key={i.key} className="bars__text">
            {i.to ? <Link to={i.to}>{i.label}</Link> : <span>{i.label}</span>}
            <span className="num">{i.value}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function StatsPage() {
  const q = useQuery({ queryKey: ['stats'], queryFn: getStats });
  const s = q.data;
  const anyMovement = s?.months.some((m) => m.in > 0 || m.out > 0) ?? false;
  // Un membre en lecture seule reçoit des statistiques sans aucun prix : les clés
  // sont absentes de la réponse (et non nulles), les sections disparaissent.
  const withPrices = s !== undefined && 'purchaseValueCents' in s;
  return (
    <>
      <TopBar title="Statistiques" />
      <main className="page">
        {q.isPending && <p className="centered">Calcul…</p>}
        {q.isError && <p role="alert" className="text-error">Impossible de charger les statistiques.</p>}
        {s && s.bottles === 0 && <p className="centered">Aucune bouteille en cave pour l’instant</p>}
        {s && s.bottles > 0 && (
          <>
            <section className="card stats-head" style={withPrices ? undefined : { gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <span><span className="stats-head__value num">{s.bottles}</span><span className="list__meta">bouteilles</span></span>
              <span><span className="stats-head__value num">{s.references}</span><span className="list__meta">références</span></span>
              {withPrices && (
                <>
                  <span>
                    <span className="stats-head__value num">{s.purchaseValueCents == null ? '—' : euros(s.purchaseValueCents)}</span>
                    <span className="list__meta">au prix d’achat</span>
                  </span>
                  {s.purchaseValueCents == null && <span className="list__meta stats-head__note">Aucun prix d’achat saisi</span>}
                  {s.purchaseValueCents != null && s.pricedReferences != null && s.pricedReferences < s.references && (
                    <span className="list__meta stats-head__note">{`sur ${s.pricedReferences} des ${s.references} références`}</span>
                  )}
                </>
              )}
            </section>
            <QuotedValue s={s} />
            <BarList
              title="Apogée"
              rows={s.byApogee.map((r) => ({ ...r, label: APOGEE_LABEL[r.key] ?? r.key, to: r.bottles > 0 ? APOGEE_LINK[r.key] : undefined }))}
            />
            <BarList title="Couleur" rows={s.byColor.map((r) => ({ ...r, label: COLOR_LABEL[r.key] ?? r.key, color: COLOR_VAR[r.key] }))} />
            <BarList title="Région" rows={plain(topWithOthers(s.byRegion, REGIONS_SHOWN))} />
            <BarList title="Millésime" rows={s.byDecade.map((r) => ({ ...r, label: r.key === 'Non millésimé' ? r.key : `Années ${r.key}` }))} />
          </>
        )}
        {s && (s.bottles > 0 || anyMovement) && (
          <MonthlyChart months={s.months} drinkRate={s.drinkRate} yearsLeft={s.yearsLeft} bottles={s.bottles} />
        )}
        {s && s.bottles > 0 && (
          <>
            <RankList title="Les plus bus" items={s.mostDrunk.map((w) => ({ key: w.id, label: wineLabel(w), value: bottlesText(w.value), to: `/cave/${w.id}` }))} />
            <RankList title="Producteurs" items={s.topProducers.map((p) => ({ key: p.producer, label: p.producer, value: bottlesText(p.bottles) }))} />
            {s.mostExpensive && (
              <RankList title="Les plus chères" items={s.mostExpensive.map((w) => ({ key: w.id, label: wineLabel(w), value: euros(w.value), to: `/cave/${w.id}` }))} />
            )}
            <RankList title="Les mieux notés" items={s.bestRated.map((w) => ({ key: w.id, label: wineLabel(w), value: formatRatingShort(w.value), to: `/cave/${w.id}` }))} />
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
