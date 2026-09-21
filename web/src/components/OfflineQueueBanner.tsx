import { useOfflineQueue } from '../lib/use-offline-queue';
import { Button } from './Button';

export function OfflineQueueBanner() {
  const { count, flushing, flushNow } = useOfflineQueue();
  if (count === 0) return null;
  return (
    <aside className="banner banner--warn" role="status">
      <span className="material-symbols-outlined">cloud_off</span>
      <span>
        <strong className="num">{count} photo{count > 1 ? 's' : ''} en attente</strong>
        <br />
        <small>Envoi automatique dès que le réseau revient (app ouverte)</small>
      </span>
      <Button variant="outline" onClick={flushNow} disabled={flushing}>{flushing ? 'Envoi…' : 'Forcer l’envoi'}</Button>
    </aside>
  );
}
