import { ChangeEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { TopBar } from '../components/TopBar';
import { enqueuePhoto, notifyQueueChanged, QueueFullError } from '../lib/offline-queue';
import { kickSender } from '../lib/photo-sender';
import { shrinkPhoto } from '../lib/shrink-photo';

/**
 * Entrée en rafale : chaque photo est réduite, rangée dans la file locale, puis
 * l'envoyeur est relancé sans être attendu. L'écran est aussitôt prêt pour la
 * suivante — l'envoi et l'analyse se font en arrière-plan, la confirmation dans
 * « À confirmer ».
 */
export function EntreeCapturePage() {
  const input = useRef<HTMLInputElement>(null);
  const [taken, setTaken] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Réinitialisé tout de suite : la même photo peut être reprise, et le champ
    // est prêt pour la suivante pendant la réduction.
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const blob = await shrinkPhoto(file);
      await enqueuePhoto(blob, 'entry');
    } catch (err) {
      setError(err instanceof QueueFullError ? err.message : 'Photo non enregistrée sur le téléphone — reprenez-la');
      return;
    }
    notifyQueueChanged();
    kickSender();
    setTaken((n) => n + 1);
  }

  return (
    <>
      <TopBar title="Rentrer du vin" back="/" />
      <main className="page capture">
        <OfflineQueueBanner />
        <p style={{ textAlign: 'center', color: 'var(--color-secondary)' }}>
          Photographiez chaque carton (mentions imprimées) ou étiquette à la suite. L’envoi et l’analyse se font en arrière-plan ; vous confirmerez les vins ensuite.
        </p>
        <p className="num" style={{ fontSize: 40, margin: 0 }} aria-hidden="true">{taken}</p>
        <small>{taken} photo{taken > 1 ? 's' : ''} prise{taken > 1 ? 's' : ''}</small>
        <input ref={input} className="capture__input" type="file" accept="image/*" capture="environment" onChange={onFile} aria-label="Prendre une photo" />
        <Button variant="primary" onClick={() => input.current?.click()} style={{ width: '100%', minHeight: 'var(--size-action-height)' }}>
          <Icon name="photo_camera" />
          {taken === 0 ? 'Prendre une photo' : 'Photo suivante'}
        </Button>
        {error && <p role="alert" className="text-error">{error}</p>}
        <Link to="/a-confirmer" className="btn btn--outline">Voir les vins à confirmer</Link>
      </main>
    </>
  );
}
