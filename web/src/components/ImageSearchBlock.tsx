import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ApiError,
  ImageCandidate,
  chooseReferenceImage,
  revertReferenceImage,
  searchWineImages,
} from '../lib/api-client';
import { Button } from './Button';

type SearchState =
  | { phase: 'closed' }
  | { phase: 'loading' }
  | { phase: 'done'; candidates: ImageCandidate[] }
  | { phase: 'error'; message: string };

function messageOf(e: unknown, overrides: Partial<Record<number, string>>): string {
  if (e instanceof ApiError) return overrides[e.status] ?? e.message;
  return e instanceof Error ? e.message : 'Une erreur est survenue';
}

const SEARCH_ERRORS = {
  503: 'Recherche d’image indisponible pour le moment',
  429: 'Trop de recherches, réessayez dans une minute',
};
const CHOOSE_ERRORS = { 410: 'Proposition expirée, relancez la recherche' };

export function ImageSearchBlock({
  wine,
}: {
  wine: { id: string; referencePhotoSource: string | null; referencePhotoSourceUrl: string | null };
}) {
  const qc = useQueryClient();
  const [state, setState] = useState<SearchState>({ phase: 'closed' });
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['cave', 'wine'].includes(String(q.queryKey[0])) });

  async function search() {
    setState({ phase: 'loading' });
    try {
      const { candidates } = await searchWineImages(wine.id);
      setState({ phase: 'done', candidates });
    } catch (e) {
      setState({ phase: 'error', message: messageOf(e, SEARCH_ERRORS) });
    }
  }

  async function choose(candidate: ImageCandidate) {
    setChoosingId(candidate.id);
    try {
      await chooseReferenceImage(wine.id, candidate.id);
      setState({ phase: 'closed' });
      void refresh();
    } catch (e) {
      setState({ phase: 'error', message: messageOf(e, CHOOSE_ERRORS) });
    } finally {
      setChoosingId(null);
    }
  }

  async function revert() {
    setRevertBusy(true);
    setRevertError(null);
    try {
      await revertReferenceImage(wine.id);
      void refresh();
    } catch (e) {
      setRevertError(e instanceof Error ? e.message : 'Retour impossible');
    } finally {
      setRevertBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginTop: 'var(--space-xs)' }}>
      {wine.referencePhotoSource && (
        <p className="list__meta" style={{ margin: 0 }}>
          Image : <a href={wine.referencePhotoSourceUrl ?? undefined} target="_blank" rel="noopener noreferrer">{wine.referencePhotoSource}</a>
        </p>
      )}
      {wine.referencePhotoSource && (
        <Button variant="link" disabled={revertBusy} onClick={revert}>Revenir à ma photo</Button>
      )}
      {revertError && <p role="alert" className="text-error">{revertError}</p>}

      {state.phase === 'closed' && (
        <Button variant="link" onClick={search}>Chercher une image</Button>
      )}

      {state.phase !== 'closed' && (
        <section className="card">
          {state.phase === 'loading' && <p>Recherche en cours…</p>}
          {state.phase === 'error' && <p role="alert" className="text-error">{state.message}</p>}
          {state.phase === 'done' && state.candidates.length === 0 && <p>Aucune image trouvée pour ce vin</p>}
          {state.phase === 'done' && state.candidates.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {state.candidates.map((c) => (
                <li key={c.id} style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                  <img src={c.imageUrl} alt={c.source} width={64} height={80} style={{ objectFit: 'cover', borderRadius: 'var(--radius-md)', flexShrink: 0 }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                    <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">{c.source}</a>
                    <Button variant="outline" disabled={choosingId !== null} onClick={() => choose(c)}>Choisir cette image</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Button variant="link" onClick={() => setState({ phase: 'closed' })}>Fermer</Button>
        </section>
      )}
    </div>
  );
}
