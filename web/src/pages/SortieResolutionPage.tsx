import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { SortieConfirmation } from '../components/SortieConfirmation';
import { TopBar } from '../components/TopBar';
import { WineThumb } from '../components/WineThumb';
import { CaveRow, ExitCandidate, ExitCandidatesResponse, ExitRead, getExitCandidates } from '../lib/api-client';

/**
 * Au-delà, la recherche dans la cave est proposée : l'utilisateur est devant la
 * bouteille, et une photo de sortie n'est jamais reportée à plus tard.
 */
export const EXIT_FALLBACK_MS = 12_000;
const POLL_MS = 1500;

function toRow(c: ExitCandidate): CaveRow {
  return { ...c.wine, quantity: c.quantity, referencePhotoId: c.referencePhotoId };
}

const isSettled = (d: ExitCandidatesResponse | undefined) => d?.status === 'DONE' || d?.status === 'FAILED';

function searchHref(read: ExitRead | null): string {
  const q = [read?.producer, read?.cuvee].filter(Boolean).join(' ');
  return q ? `/cave?q=${encodeURIComponent(q)}` : '/cave';
}

export function SortieResolutionPage() {
  const { photoId = '' } = useParams();
  const [late, setLate] = useState(false);
  const [chosen, setChosen] = useState<ExitCandidate | null>(null);
  const [exited, setExited] = useState(false);
  // Première réponse définitive (DONE ou FAILED), figée pour cette photo : un
  // rafraîchissement ultérieur (retour sur l'application) ne doit pas réécrire
  // l'écran. Après la sortie de la dernière bouteille, le vin n'est plus
  // candidat — sans ce gel, le résultat et « Annuler » disparaîtraient au profit
  // de « Ce vin n'est pas dans la cave ».
  const [settled, setSettled] = useState<{ photoId: string; data: ExitCandidatesResponse } | null>(null);
  const result = useQuery({
    queryKey: ['exit-candidates', photoId],
    queryFn: () => getExitCandidates(photoId),
    refetchInterval: (q) => (isSettled(q.state.data) ? false : POLL_MS),
    refetchOnWindowFocus: (q) => !isSettled(q.state.data),
  });
  const pinned = settled?.photoId === photoId ? settled.data : null;

  useEffect(() => {
    if (!pinned && isSettled(result.data)) setSettled({ photoId, data: result.data! });
  }, [pinned, photoId, result.data]);

  useEffect(() => {
    setLate(false);
    const timer = setTimeout(() => setLate(true), EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [photoId]);

  const data = pinned ?? result.data;
  const read = data?.status === 'DONE' ? data.read : null;
  const fallback = <Link to={searchHref(read)} className="btn btn--outline">Chercher dans la cave</Link>;

  let body;
  if ((!pinned && result.isError) || data?.status === 'FAILED') {
    body = (
      <section className="card" role="alert">
        <p className="text-error" style={{ margin: 0 }}>Lecture impossible</p>
        <p>Retrouvez la bouteille dans la cave : rien n’a été sorti.</p>
        {fallback}
      </section>
    );
  } else if (data?.status === 'DONE' && (chosen || data.outcome === 'UNIQUE')) {
    body = (
      <>
        {/* Une fois la sortie faite, changer de millésime reviendrait à réutiliser
            la même photo pour un autre vin : on ne le propose plus (Annuler reste). */}
        {chosen && data.outcome === 'SEVERAL' && !exited && (
          <Button variant="link" onClick={() => setChosen(null)}>Choisir un autre millésime</Button>
        )}
        <SortieConfirmation wine={toRow(chosen ?? data.candidates[0])} photoId={photoId} onDone={() => setExited(true)} />
      </>
    );
  } else if (data?.status === 'DONE' && data.outcome === 'SEVERAL') {
    body = (
      <section>
        <h2 style={{ fontSize: 18 }}>Lequel est-ce ?</h2>
        <div className="candidates">
          {data.candidates.map((c) => (
            <button key={c.wine.id} type="button" className="candidate" onClick={() => setChosen(c)}>
              <WineThumb photoId={c.referencePhotoId} size={88} />
              <span className="candidate__vintage num">{c.wine.vintage ?? 'NV'}</span>
              {/* Même millésime en bouteille et en magnum : seul le format les distingue. */}
              <span className="list__meta num">{c.wine.formatCl} cl</span>
              <span className="list__meta">{c.wine.producer}{c.wine.cuvee ? ` — ${c.wine.cuvee}` : ''}</span>
            </button>
          ))}
        </div>
        {fallback}
      </section>
    );
  } else if (data?.status === 'DONE') {
    body = (
      <section className="card">
        <p style={{ margin: 0, fontWeight: 600 }}>Ce vin n’est pas dans la cave</p>
        {fallback}
        <Link to="/entree" className="btn btn--primary">Rentrer ce vin</Link>
      </section>
    );
  } else {
    body = (
      <section className="card">
        <p>Lecture de l’étiquette…</p>
        <div className="progress"><span /></div>
        {late && fallback}
      </section>
    );
  }

  return (
    <>
      <TopBar title="Sortir une bouteille" back="/sortie" />
      <main className="page">
        <img className="preview" src={`/api/photos/${photoId}/image?variant=display`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        {body}
      </main>
    </>
  );
}
