import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SortieConfirmation } from '../components/SortieConfirmation';
import { TopBar } from '../components/TopBar';
import { WineThumb } from '../components/WineThumb';
import { CaveRow, ExitCandidate, ExitRead, getExitCandidates } from '../lib/api-client';

/**
 * Au-delà, la recherche dans la cave est proposée : l'utilisateur est devant la
 * bouteille, et une photo de sortie n'est jamais reportée à plus tard.
 */
export const EXIT_FALLBACK_MS = 12_000;
const POLL_MS = 1500;

function toRow(c: ExitCandidate): CaveRow {
  return { ...c.wine, quantity: c.quantity, referencePhotoId: c.referencePhotoId };
}

function searchHref(read: ExitRead | null): string {
  const q = [read?.producer, read?.cuvee].filter(Boolean).join(' ');
  return q ? `/cave?q=${encodeURIComponent(q)}` : '/cave';
}

export function SortieResolutionPage() {
  const { photoId = '' } = useParams();
  const [late, setLate] = useState(false);
  const [chosen, setChosen] = useState<ExitCandidate | null>(null);
  const result = useQuery({
    queryKey: ['exit-candidates', photoId],
    queryFn: () => getExitCandidates(photoId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'DONE' || q.state.data.status === 'FAILED') ? false : POLL_MS),
  });

  useEffect(() => {
    setLate(false);
    const timer = setTimeout(() => setLate(true), EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [photoId]);

  const data = result.data;
  const read = data?.status === 'DONE' ? data.read : null;
  const fallback = <Link to={searchHref(read)} className="btn btn--outline">Chercher dans la cave</Link>;

  let body;
  if (result.isError || data?.status === 'FAILED') {
    body = (
      <section className="card" role="alert">
        <p className="text-error" style={{ margin: 0 }}>Lecture impossible</p>
        <p>Retrouvez la bouteille dans la cave : rien n’a été sorti.</p>
        {fallback}
      </section>
    );
  } else if (data?.status === 'DONE' && (chosen || data.outcome === 'UNIQUE')) {
    body = <SortieConfirmation wine={toRow(chosen ?? data.candidates[0])} photoId={photoId} />;
  } else if (data?.status === 'DONE' && data.outcome === 'SEVERAL') {
    body = (
      <section>
        <h2 style={{ fontSize: 18 }}>Lequel est-ce ?</h2>
        <div className="candidates">
          {data.candidates.map((c) => (
            <button key={c.wine.id} type="button" className="candidate" onClick={() => setChosen(c)}>
              <WineThumb photoId={c.referencePhotoId} size={88} />
              <span className="candidate__vintage num">{c.wine.vintage ?? 'NV'}</span>
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
        <img className="preview" src={`/api/photos/${photoId}/image`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        {body}
      </main>
    </>
  );
}
