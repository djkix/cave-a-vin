import { useCurrentCave } from '../lib/use-current-cave';
import { useOfflineQueue } from '../lib/use-offline-queue';
import { Icon } from './Icon';
import { Button } from './Button';

/**
 * Photos encore sur le téléphone. Celles d'un autre compte (téléphone partagé)
 * ne sont ni comptées ni envoyées ici : une simple mention les signale.
 * `readOnly` (membre en lecture seule) : seulement cette mention, et, dans une
 * cave où l'on n'est que membre, une note sur ses propres photos, qui
 * attendent que sa cave soit de nouveau sélectionnée.
 */
export function OfflineQueueBanner({ readOnly = false }: { readOnly?: boolean }) {
  const { me, role } = useCurrentCave();
  const { count, others, flushing, flushNow } = useOfflineQueue(me?.id);
  const showBanner = !readOnly && count > 0;
  const showViewerNote = readOnly && role === 'VIEWER' && count > 0;
  if (!showBanner && !showViewerNote && others === 0) return null;
  return (
    <>
      {showViewerNote && (
        <p className="list__meta" style={{ margin: 0 }}>
          {count > 1
            ? `${count} photos en attente : elles partiront quand votre cave sera sélectionnée`
            : '1 photo en attente : elle partira quand votre cave sera sélectionnée'}
        </p>
      )}
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
