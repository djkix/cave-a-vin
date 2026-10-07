import { useCurrentCave } from '../lib/use-current-cave';
import { useOfflineQueue } from '../lib/use-offline-queue';
import { Icon } from './Icon';
import { Button } from './Button';

/**
 * Photos encore sur le téléphone. Celles d'un autre compte (téléphone partagé)
 * ne sont ni comptées ni envoyées ici : une simple mention les signale.
 * `readOnly` (membre en lecture seule) : seulement cette mention.
 */
export function OfflineQueueBanner({ readOnly = false }: { readOnly?: boolean }) {
  const { me } = useCurrentCave();
  const { count, others, flushing, flushNow } = useOfflineQueue(me?.id);
  const showBanner = !readOnly && count > 0;
  if (!showBanner && others === 0) return null;
  return (
    <>
      {others > 0 && <p className="list__meta" style={{ margin: 0 }}>{`Photos en attente d’un autre compte : ${others}`}</p>}
      {showBanner && (
        <aside className="banner banner--warn" role="status">
          <Icon name="cloud_off" />
          <span>
            <strong className="num">{count} photo{count > 1 ? 's' : ''} en cours d’envoi</strong>
            <br />
            <small>Envoi automatique dès que le réseau revient (app ouverte)</small>
          </span>
          <Button variant="outline" onClick={flushNow} disabled={flushing}>{flushing ? 'Envoi…' : 'Forcer l’envoi'}</Button>
        </aside>
      )}
    </>
  );
}
