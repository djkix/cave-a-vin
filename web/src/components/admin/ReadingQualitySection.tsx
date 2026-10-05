import { useQuery } from '@tanstack/react-query';
import { getReadingQuality, ReadField } from '../../lib/api-client';

/** Objectif du cahier des charges : moins de 15 % de champs corrigés à la main. */
const TARGET = 0.15;

const FIELD_LABEL: Record<ReadField, string> = {
  producer: 'Producteur', cuvee: 'Cuvée', appellationRaw: 'Appellation', vintage: 'Millésime', color: 'Couleur', formatCl: 'Format',
};

const pct = (r: number) => `${Math.round(r * 100)} %`;

/** Mesure « zéro saisie » : part des champs que la lecture de l'étiquette n'a pas su remplir juste. */
export function ReadingQualitySection() {
  const q = useQuery({ queryKey: ['admin', 'reading-quality'], queryFn: getReadingQuality });
  const d = q.data;
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Qualité de la lecture</h2>
      {q.isError && <p role="alert" className="text-error">Impossible de charger la mesure.</p>}
      {d && d.rate == null && <p className="list__meta">Aucune entrée par photo mesurée sur {d.days} jours.</p>}
      {d && d.rate != null && (
        <>
          <p style={{ margin: 'var(--space-sm) 0' }}>
            {`${pct(d.rate)} de champs corrigés à la main — ${d.entries} ${d.entries > 1 ? 'entrées' : 'entrée'} sur ${d.days} jours`}
          </p>
          <span className={`badge ${d.rate < TARGET ? 'badge--ok' : 'badge--warn'}`}>
            {d.rate < TARGET ? 'Objectif atteint (moins de 15 %)' : 'Au-dessus de l’objectif (moins de 15 %)'}
          </span>
          <table style={{ width: '100%', marginTop: 'var(--space-sm)', borderCollapse: 'collapse' }}>
            <thead>
              <tr className="list__meta"><th style={{ textAlign: 'left' }}>Champ</th><th style={{ textAlign: 'right' }}>Corrigé</th></tr>
            </thead>
            <tbody>
              {d.fields.map((f) => (
                <tr key={f.field}>
                  <td>{FIELD_LABEL[f.field]}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{f.rate == null ? '—' : pct(f.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
