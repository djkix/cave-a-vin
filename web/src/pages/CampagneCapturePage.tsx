import { ChangeEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { TopBar } from '../components/TopBar';
import { uploadPhoto } from '../lib/api-client';
import { enqueuePhoto, QueueFullError } from '../lib/offline-queue';
import { notifyQueueChanged } from '../lib/use-offline-queue';

export function CampagneCapturePage() {
  const input = useRef<HTMLInputElement>(null);
  const [taken, setTaken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      if (!navigator.onLine) throw new TypeError('offline');
      await uploadPhoto(file);
    } catch (err) {
      if (!(err instanceof TypeError)) return setError(err instanceof Error ? err.message : 'Envoi impossible');
      try {
        await enqueuePhoto(file, 'campaign');
        notifyQueueChanged();
      } catch (q) {
        return setError(q instanceof QueueFullError ? q.message : 'File hors ligne indisponible');
      }
    }
    setTaken((n) => n + 1);
  }

  return (
    <>
      <TopBar title="Mode campagne" back="/" />
      <main className="page capture">
        <OfflineQueueBanner />
        <p style={{ textAlign: 'center', color: 'var(--color-secondary)' }}>
          Photographiez chaque référence à la suite : appuyez sur « Photo suivante » après chaque prise. L’analyse se fait en arrière-plan ; vous validerez tout d’un coup dans la revue.
        </p>
        <p className="num" style={{ fontSize: 40, margin: 0 }}>{taken}</p>
        <small>photos prises dans cette session</small>
        <input ref={input} className="capture__input" type="file" accept="image/*" capture="environment" onChange={onFile} aria-label="Photo suivante" />
        <Button variant="primary" onClick={() => input.current?.click()} style={{ width: '100%', minHeight: 'var(--size-action-height)' }}>
          <span className="material-symbols-outlined">photo_camera</span>
          {taken === 0 ? 'Commencer' : 'Photo suivante'}
        </Button>
        {error && <p role="alert" className="text-error">{error}</p>}
        <Link to="/entree/campagne/revue" className="btn btn--outline">Passer à la revue groupée</Link>
      </main>
    </>
  );
}
