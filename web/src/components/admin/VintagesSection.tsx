import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { deleteVintage, getVintages, putVintage, VintageQualityLevel, VintageQualityRow } from '../../lib/api-client';
import { Button } from '../Button';

const QUALITY_LABEL: Record<VintageQualityLevel, string> = { GRAND: 'Grand', MOYEN: 'Moyen', FAIBLE: 'Faible' };

/** Une qualité de millésime change les apogées de toute la région : on rafraîchit aussi la cave. */
const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => ['admin', 'cave', 'wine'].includes(String(q.queryKey[0])) });

export function VintagesSection() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'vintages'], queryFn: getVintages });
  const [region, setRegion] = useState('');
  const [yearText, setYearText] = useState('');
  // Fonctions enveloppées : la mutation reçoit exactement un argument, quelle que soit la version de TanStack Query.
  // Évite qu'une erreur de l'autre mutation reste affichée après celle-ci :
  // des refs (et non les mutations elles-mêmes, qui se référenceraient
  // circulairement) portent le dernier « reset » de chacune.
  const resetDel = useRef<() => void>(() => {});
  const resetPut = useRef<() => void>(() => {});
  const put = useMutation({
    mutationFn: (row: VintageQualityRow) => putVintage(row),
    onMutate: () => resetDel.current(),
    onSuccess: () => invalidate(qc),
  });
  resetPut.current = () => put.reset();
  const del = useMutation({
    mutationFn: ({ r, y }: { r: string; y: number }) => deleteVintage(r, y),
    onMutate: () => resetPut.current(),
    onSuccess: () => invalidate(qc),
  });
  resetDel.current = () => del.reset();

  const regions = data.data?.regions ?? [];
  const chosenRegion = region || regions[0] || '';
  const year = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
  const error = (put.error ?? del.error) as Error | null;

  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Qualité des millésimes</h2>
      <p className="list__meta">Un millésime non qualifié vaut « moyen » et abaisse la confiance des apogées.</p>
      {data.isError && <p role="alert" className="text-error">Impossible de charger les millésimes.</p>}
      {data.data && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'center' }}>
          <label htmlFor="vintage-region" className="field__label">Région</label>
          <select id="vintage-region" value={chosenRegion} onChange={(e) => setRegion(e.target.value)}>
            {regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label htmlFor="vintage-year" className="field__label">Année</label>
          <input id="vintage-year" inputMode="numeric" value={yearText} onChange={(e) => setYearText(e.target.value.trim())} style={{ width: 96 }} />
          {(Object.keys(QUALITY_LABEL) as VintageQualityLevel[]).map((q) => (
            <Button key={q} variant="outline" disabled={year === null || !chosenRegion || put.isPending}
              onClick={() => year !== null && put.mutate({ region: chosenRegion, year, quality: q })}>
              {QUALITY_LABEL[q]}
            </Button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-error">{error.message}</p>}
      <div className="list" style={{ marginTop: 'var(--space-sm)' }}>
        {data.data?.qualities.map((v) => (
          <div key={`${v.region}-${v.year}`} className="list__row">
            <span style={{ flex: 1 }}>{`${v.region} ${v.year} — ${QUALITY_LABEL[v.quality]}`}</span>
            <Button variant="link" aria-label={`Retirer ${v.region} ${v.year}`} disabled={del.isPending} onClick={() => del.mutate({ r: v.region, y: v.year })}>
              Retirer
            </Button>
          </div>
        ))}
        {data.data?.qualities.length === 0 && <p className="centered">Aucun millésime qualifié : tous valent « moyen ».</p>}
      </div>
    </section>
  );
}
