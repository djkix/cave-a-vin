import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { GeminiUsageKind, getGeminiUsage } from '../../lib/api-client';

const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const euros = (cents: number) => EUR.format(cents / 100);
const parisTime = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

const USAGE_LABEL: Record<GeminiUsageKind, string> = {
  LECTURE_ENTREE: 'Lecture à l’entrée',
  LECTURE_SORTIE: 'Lecture à la sortie',
  ACCORDS: 'Accords',
  DESCRIPTIF: 'Descriptifs',
  RECHERCHE_IMAGE: 'Recherche d’image',
};

const PERIODS = [7, 30] as const;

/** « 2026-10-08 » → « 08/10 » : le jour est déjà celui de Paris, calculé par l'api. */
const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

const cell = { padding: '2px var(--space-xs)', whiteSpace: 'nowrap' } as const;
const numCell = { ...cell, textAlign: 'right' } as const;

/** Consommation Gemini par jour et par usage, refus de Google compris, et pause commune en cours. */
export function GeminiUsageSection() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const q = useQuery({ queryKey: ['admin', 'gemini-usage', days], queryFn: () => getGeminiUsage(days) });
  const d = q.data;
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Consommation Gemini</h2>
      <div role="group" aria-label="Période" style={{ display: 'flex', gap: 'var(--space-xs)', margin: 'var(--space-xs) 0' }}>
        {PERIODS.map((p) => (
          <button key={p} type="button" className={`pill${days === p ? ' pill--active' : ''}`} aria-pressed={days === p} onClick={() => setDays(p)}>
            {p} jours
          </button>
        ))}
      </div>
      {q.isError && <p role="alert" className="text-error">Impossible de charger la consommation Gemini.</p>}
      {d?.pause.until && (
        <p className="badge badge--warn" style={{ whiteSpace: 'normal' }}>
          {`Gemini en pause jusqu'à ${parisTime.format(new Date(d.pause.until))} (${d.pause.reason ?? 'refus de Google'}) : aucun appel n'est envoyé d'ici là.`}
        </p>
      )}
      {d && d.rows.length === 0 && <p className="list__meta">Aucun appel à Gemini sur {days} jours.</p>}
      {d && d.rows.length > 0 && (
        <>
          {/* Sept colonnes : défilement horizontal dans la carte à 375 px, jamais de la page. */}
          <div style={{ overflowX: 'auto', marginTop: 'var(--space-sm)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr className="list__meta">
                  <th style={{ ...cell, textAlign: 'left' }}>Jour</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Usage</th>
                  <th style={numCell}>Réussis</th>
                  <th style={numCell}>Refusés (saturé)</th>
                  <th style={numCell}>Refusés (quota)</th>
                  <th style={numCell}>Erreurs</th>
                  <th style={numCell}>Coût</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={`${r.day}|${r.usage}`}>
                    <td style={cell} className="num">{shortDay(r.day)}</td>
                    <td style={cell}>{USAGE_LABEL[r.usage] ?? r.usage}</td>
                    <td style={numCell} className="num">{r.ok}</td>
                    <td style={numCell} className="num">{r.refused503}</td>
                    <td style={numCell} className="num">{r.refused429}</td>
                    <td style={numCell} className="num">{r.errors}</td>
                    <td style={numCell} className="num">{euros(r.costCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="num" style={{ margin: 'var(--space-sm) 0' }}>
            {`Total : ${plural(d.totals.ok, 'réussi', 'réussis')}, ${plural(d.totals.refused, 'refusé', 'refusés')}, ${plural(d.totals.errors, 'erreur', 'erreurs')} — ${euros(d.totals.costCents)}`}
          </p>
        </>
      )}
      <p className="list__meta">
        Un refus de Google (saturé ou quota) compte dans ses statistiques de requêtes mais n'est pas facturé. Après un refus, l'application met Gemini en pause (5 min si saturé, 1 h si quota épuisé) au lieu de réessayer.
      </p>
    </section>
  );
}
