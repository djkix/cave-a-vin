const SHORT = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const ONE_DECIMAL = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const asDate = (month: string) => new Date(`${month}-01T00:00:00Z`);

function rhythm(drinkRate: number, yearsLeft: number | null, bottles: number): string {
  if (drinkRate === 0) return 'Aucune bouteille sortie sur 12 mois';
  const rate = `En moyenne ${ONE_DECIMAL.format(drinkRate)} ${drinkRate >= 2 ? 'bouteilles bues' : 'bouteille bue'} par mois`;
  if (yearsLeft == null || bottles === 0) return rate;
  return `${rate} — ${yearsLeft < 1 ? 'moins d’un an' : `environ ${plural(yearsLeft, 'an', 'ans')}`} de cave à ce rythme`;
}

/** Histogramme des 12 derniers mois : une barre d'entrées, une de sorties. */
export function MonthlyChart({ months, drinkRate, yearsLeft, bottles }: {
  months: Array<{ month: string; in: number; out: number }>; drinkRate: number; yearsLeft: number | null; bottles: number;
}) {
  const max = Math.max(1, ...months.flatMap((m) => [m.in, m.out]));
  const height = (n: number) => `${Math.round((n / max) * 100)}%`;
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Mouvements sur 12 mois</h2>
      <div className="histo" role="list">
        {months.map((m) => (
          <div
            key={m.month}
            role="listitem"
            className="histo__col"
            aria-label={`${LONG.format(asDate(m.month))} : ${plural(m.in, 'entrée', 'entrées')}, ${plural(m.out, 'sortie', 'sorties')}`}
          >
            <span className="histo__bars" aria-hidden="true">
              <span className="histo__bar histo__bar--in" style={{ height: height(m.in) }} />
              <span className="histo__bar histo__bar--out" style={{ height: height(m.out) }} />
            </span>
            <span className="histo__label" aria-hidden="true">{SHORT.format(asDate(m.month))}</span>
          </div>
        ))}
      </div>
      <p className="list__meta">
        <span className="histo__key histo__key--in" aria-hidden="true" /> Entrées{' '}
        <span className="histo__key histo__key--out" aria-hidden="true" /> Sorties
      </p>
      <p style={{ margin: 0 }}>{rhythm(drinkRate, yearsLeft, bottles)}</p>
    </section>
  );
}
