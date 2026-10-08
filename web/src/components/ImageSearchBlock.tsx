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
  | { phase: 'done'; candidates: ImageCandidate[]; chooseError?: string }
  | { phase: 'error'; message: string };

function messageOf(e: unknown, overrides: Partial<Record<number, string>>): string {
  if (e instanceof ApiError) return overrides[e.status] ?? e.message;
  return e instanceof Error ? e.message : 'Une erreur est survenue';
}

const UNAVAILABLE = 'Recherche d’image indisponible pour le moment';
// 502 et 504 : le proxy devant l'api (passerelle en panne, délai dépassé), la
// requête n'a pas reçu de réponse de l'application : dit à part du 503 de l'api,
// pour savoir où chercher.
const NO_ANSWER = 'Recherche d’image indisponible pour le moment (le serveur n’a pas répondu)';
// 503 : l'api donne elle-même la raison (indisponible, part de la cave atteinte,
// quota Gemini épuisé) : son message est affiché tel quel.
const SEARCH_ERRORS = {
  502: NO_ANSWER,
  504: NO_ANSWER,
  429: 'Trop de recherches, réessayez dans une minute',
};
const CHOOSE_ERRORS = { 410: 'Proposition expirée, relancez la recherche' };

export function ImageSearchBlock({
  wine,
  readOnly = false,
}: {
  wine: { id: string; referencePhotoSource: string | null; referencePhotoSourceUrl: string | null };
  /** Membre en lecture seule : la source de l'image reste citée, sans recherche ni retour à la photo. */
  readOnly?: boolean;
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
      // Un 503 sans message de l'api (page d'erreur d'un proxy) reste « indisponible ».
      const bare = e instanceof ApiError && e.status === 503 && /^(Service Unavailable)?$/i.test(e.message);
      setState({ phase: 'error', message: bare ? UNAVAILABLE : messageOf(e, SEARCH_ERRORS) });
    }
  }

  async function choose(candidate: ImageCandidate, candidates: ImageCandidate[]) {
    setChoosingId(candidate.id);
    try {
      await chooseReferenceImage(wine.id, candidate.id);
      setState({ phase: 'closed' });
      void refresh();
    } catch (e) {
      const message = messageOf(e, CHOOSE_ERRORS);
      // Proposition expirée : il faut relancer la recherche, la liste ne sert plus.
      // Toute autre erreur : on garde les images pour réessayer ou en choisir une autre.
      if (e instanceof ApiError && e.status === 410) setState({ phase: 'error', message });
      else setState({ phase: 'done', candidates, chooseError: message });
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
    <div className="image-search">
      {wine.referencePhotoSource && (
        <p className="list__meta image-search__source">
          Image :{' '}
          <a className="link" href={wine.referencePhotoSourceUrl ?? undefined} target="_blank" rel="noopener noreferrer">
            {wine.referencePhotoSource}
          </a>
        </p>
      )}
      {!readOnly && (wine.referencePhotoSource || state.phase === 'closed') && (
        <div className="image-search__actions">
          {state.phase === 'closed' && (
            <Button variant="link" onClick={search}>Chercher une image</Button>
          )}
          {wine.referencePhotoSource && (
            <Button variant="link" disabled={revertBusy} onClick={revert}>Revenir à ma photo</Button>
          )}
        </div>
      )}
      {revertError && <p role="alert" className="text-error">{revertError}</p>}

      {state.phase !== 'closed' && (
        <section className="image-search__window" aria-label="Images proposées">
          {state.phase === 'loading' && <p>Recherche en cours…</p>}
          {state.phase === 'error' && <p role="alert" className="text-error">{state.message}</p>}
          {state.phase === 'done' && state.candidates.length === 0 && <p>Aucune image trouvée pour ce vin</p>}
          {state.phase === 'done' && state.chooseError && <p role="alert" className="text-error">{state.chooseError}</p>}
          {state.phase === 'done' && state.candidates.length > 0 && (
            <ul className="image-search__grid">
              {state.candidates.map((c) => (
                <li key={c.id} className="image-search__candidate">
                  <img src={c.imageUrl} alt={c.source} className="image-search__image" />
                  <a className="link image-search__link" href={c.sourceUrl} target="_blank" rel="noopener noreferrer">{c.source}</a>
                  <Button
                    variant="outline"
                    className="image-search__choose"
                    disabled={choosingId !== null}
                    onClick={() => choose(c, state.candidates)}
                  >
                    Choisir cette image
                  </Button>
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
