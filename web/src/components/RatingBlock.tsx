import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CaveRow, clearRating, setRating } from '../lib/api-client';
import { formatRating, parseRating } from '../lib/rating';
import { Button } from './Button';

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/** `readOnly` : membre en lecture seule, qui voit la note sans pouvoir la changer. */
export function RatingBlock({ wine, readOnly = false }: { wine: CaveRow; readOnly?: boolean }) {
  const qc = useQueryClient();
  const rating = wine.rating ?? null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verdict = parseRating(text);
  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['cave', 'wine', 'stats'].includes(String(q.queryKey[0])) });

  function open() {
    setText(rating ? String(rating.value).replace('.', ',') : '');
    setError(null);
    setEditing(true);
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  }

  if (readOnly && !rating) return null;
  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>{readOnly ? 'Note' : 'Ma note'}</h3>
      {rating && !editing && (
        <>
          <p className="num" style={{ fontSize: 22, margin: 'var(--space-xs) 0' }}>{formatRating(rating.value)}</p>
          <p className="list__meta" style={{ margin: 0 }}>
            {`notée le ${DATE.format(new Date(rating.ratedAt))}${rating.ratedBy ? ` par ${rating.ratedBy}` : ''}`}
          </p>
        </>
      )}
      {error && <p role="alert" className="text-error">{error}</p>}
      {readOnly ? null : editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
          <label className="field__label" htmlFor="rating-value">Note sur 20</label>
          <input id="rating-value" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="16,5" />
          {typeof verdict === 'string' && text.trim() !== '' && <p className="text-error" style={{ margin: 0 }}>{verdict}</p>}
          <Button variant="dark" disabled={busy || typeof verdict === 'string'} onClick={() => typeof verdict === 'number' && run(() => setRating(wine.id, verdict))}>
            Enregistrer la note
          </Button>
          <Button variant="link" onClick={() => { setEditing(false); setError(null); }}>Abandonner</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
          {rating ? (
            <>
              <Button variant="outline" onClick={open}>Modifier</Button>
              <Button variant="link" disabled={busy} onClick={() => run(() => clearRating(wine.id))}>Retirer</Button>
            </>
          ) : (
            <Button variant="outline" onClick={open}>Noter ce vin</Button>
          )}
        </div>
      )}
    </section>
  );
}
