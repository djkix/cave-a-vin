import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deleteGuard, GuardAppellation, putGuard, searchGuards, WineColor } from '../../lib/api-client';
import { Button } from '../Button';

const COLOR_LABEL: Record<WineColor, string> = { ROUGE: 'Rouge', BLANC: 'Blanc', ROSE: 'Rosé', PETILLANT: 'Pétillant' };
const colorLabel = (c: WineColor | null) => (c ? COLOR_LABEL[c] : 'Toutes couleurs');
const years = (min: number | null, max: number | null) => (min == null || max == null ? 'inconnue' : `${min} à ${max} ans`);

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => ['admin', 'cave', 'wine'].includes(String(q.queryKey[0])) });

export function GuardsSection() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<GuardAppellation | null>(null);
  const [color, setColor] = useState<WineColor | ''>('');
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const results = useQuery({ queryKey: ['admin', 'guards', q], queryFn: () => searchGuards(q), enabled: q.trim().length >= 2 });
  const put = useMutation({
    mutationFn: (input: { appellationId: string; color: WineColor | null; min: number; max: number }) => putGuard(input),
    onSuccess: () => { setSelected(null); void invalidate(qc); },
  });
  const del = useMutation({ mutationFn: (id: string) => deleteGuard(id), onSuccess: () => invalidate(qc) });

  const min = /^\d{1,3}$/.test(minText) ? Number(minText) : null;
  const max = /^\d{1,3}$/.test(maxText) ? Number(maxText) : null;
  const valid = min !== null && max !== null && min <= max && max <= 100;
  const error = (put.error ?? del.error) as Error | null;

  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Gardes</h2>
      <label htmlFor="guard-search" className="field__label">Appellation</label>
      <input id="guard-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Au moins deux lettres" />
      {error && <p role="alert" className="text-error">{error.message}</p>}
      <div className="list" style={{ marginTop: 'var(--space-sm)' }}>
        {results.data?.map((a) => (
          <div key={a.id} className="list__row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <strong>{a.canonicalName}</strong>
            <span className="list__meta">Garde du référentiel : {years(a.guardMinYears, a.guardMaxYears)}</span>
            {a.overrides.map((o) => (
              <span key={o.id} className="list__meta" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                {/* Texte dans son propre élément, séparé du bouton : il reste lisible et retrouvable seul. */}
                <span>{`${colorLabel(o.color)} : ${years(o.min, o.max)}`}</span>
                <Button variant="link" aria-label={`Retirer l’ajustement ${colorLabel(o.color)}`} disabled={del.isPending} onClick={() => del.mutate(o.id)}>
                  Retirer
                </Button>
              </span>
            ))}
            <Button variant="outline" aria-label={`Ajuster ${a.canonicalName}`} onClick={() => { setSelected(a); setColor(''); setMinText(''); setMaxText(''); }}>
              Ajuster
            </Button>
            {selected?.id === a.id && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'center' }}>
                <label htmlFor="guard-color" className="field__label">Couleur</label>
                <select id="guard-color" value={color} onChange={(e) => setColor(e.target.value as WineColor | '')}>
                  <option value="">Toutes couleurs</option>
                  {(Object.keys(COLOR_LABEL) as WineColor[]).map((c) => <option key={c} value={c}>{COLOR_LABEL[c]}</option>)}
                </select>
                <label htmlFor="guard-min" className="field__label">Garde minimale</label>
                <input id="guard-min" inputMode="numeric" value={minText} onChange={(e) => setMinText(e.target.value.trim())} style={{ width: 72 }} />
                <label htmlFor="guard-max" className="field__label">Garde maximale</label>
                <input id="guard-max" inputMode="numeric" value={maxText} onChange={(e) => setMaxText(e.target.value.trim())} style={{ width: 72 }} />
                <Button variant="dark" disabled={!valid || put.isPending}
                  onClick={() => valid && put.mutate({ appellationId: a.id, color: color || null, min: min!, max: max! })}>
                  Enregistrer la garde
                </Button>
              </div>
            )}
          </div>
        ))}
        {results.data?.length === 0 && <p className="centered">Aucune appellation ne correspond.</p>}
      </div>
    </section>
  );
}
