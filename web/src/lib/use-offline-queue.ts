import { useCallback, useEffect, useState } from 'react';
import { notifyQueueChanged, queueStats, subscribeQueueChanged } from './offline-queue';
import { sendQueuedPhotos } from './photo-sender';

// Ré-exporté pour compatibilité : les écrans de capture notifient la file
// depuis ce module historique.
export { notifyQueueChanged };

/**
 * État de la file locale pour l'affichage (bandeau) et envoi forcé à la demande.
 * L'envoi automatique (minuterie, retour du réseau…) est porté une seule fois
 * pour toute l'application par `useBackgroundSender`.
 */
export function useOfflineQueue() {
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [flushing, setFlushing] = useState(false);

  const refresh = useCallback(() => void queueStats().then(setStats), []);

  const flushNow = useCallback(async () => {
    if (!navigator.onLine) return;
    setFlushing(true);
    try {
      await sendQueuedPhotos();
    } finally {
      setFlushing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    return subscribeQueueChanged(refresh);
  }, [refresh]);

  return { ...stats, flushing, flushNow };
}
