import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { cancelMovement, exportUrl, getRecentMovements, MovementWithWine, WineColor } from '../lib/api-client';

const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function MovementRow({ m, onCancel, cancelling }: { m: MovementWithWine; onCancel?: (id: string) => void; cancelling?: boolean }) {
  const isIn = m.delta > 0;
  return (
    <div className="list__row">
      <Icon name={isIn ? 'add' : 'remove'} style={{ color: isIn ? 'var(--color-primary-action)' : 'var(--color-secondary)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span className={`list__delta ${isIn ? 'list__delta--in' : 'list__delta--out'} num`}>{isIn ? `+${m.delta}` : m.delta}</span>
        <span className="list__meta"> · {fmt.format(new Date(m.occurredAt))}</span>
        <p className="list__title" style={{ margin: 0 }}>
          {m.wine.producer}{m.wine.cuvee ? ` — ${m.wine.cuvee}` : ''} {m.wine.vintage ?? ''}
        </p>
        <span className="list__meta">{m.wine.appellationRaw}{m.note ? ` · ${m.note}` : ''}</span>
      </div>
      {onCancel && !m.reversesId && (
        <Button variant="outline" onClick={() => onCancel(m.id)} disabled={cancelling}>Annuler</Button>
      )}
    </div>
  );
}

export function JournalPage() {
  const qc = useQueryClient();
  const movements = useQuery({ queryKey: ['movements', 'recent'], queryFn: () => getRecentMovements(20) });
  const [color, setColor] = useState<WineColor | ''>('');
  const cancel = useMutation({
    mutationFn: (id: string) => cancelMovement(id, crypto.randomUUID()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['movements'] }),
  });

  return (
    <>
      <TopBar title="Journal" />
      <main className="page">
        <section className="card">
          <h2 style={{ fontSize: 18 }}>Export Excel</h2>
          <label className="field__label" style={{ marginTop: 'var(--space-sm)' }}>
            Filtre couleur
            <select value={color} onChange={(e) => setColor(e.target.value as WineColor | '')}>
              <option value="">Toute la cave</option>
              <option value="ROUGE">Rouge</option>
              <option value="BLANC">Blanc</option>
              <option value="ROSE">Rosé</option>
              <option value="PETILLANT">Pétillant</option>
            </select>
          </label>
          <a className="btn btn--primary" style={{ width: '100%', marginTop: 'var(--space-sm)' }} href={exportUrl(color ? { color } : {})} download>
            <Icon name="download" />
            Exporter le classeur
          </a>
        </section>
        <h2 style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)' }}>20 DERNIERS MOUVEMENTS</h2>
        {cancel.isError && <p role="alert" className="text-error">{(cancel.error as Error).message}</p>}
        <div className="list">
          {movements.data?.map((m) => <MovementRow key={m.id} m={m} onCancel={(id) => cancel.mutate(id)} cancelling={cancel.isPending} />)}
          {movements.data?.length === 0 && <p className="centered">Aucun mouvement pour l’instant.</p>}
        </div>
      </main>
      <BottomNav />
    </>
  );
}
