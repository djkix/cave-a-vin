import { useCallback, useEffect, useState } from 'react';
import { notifyQueueChanged, queueStats, subscribeQueueChanged } from './offline-queue';
import { sendQueuedPhotos } from './photo-sender';

// Ré-exporté pour compatibilité : les écrans de capture notifient la file
// depuis ce module historique.
export { notifyQueueChanged };

const SENDER_INTERVAL_MS = 15_000;

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
    const unsubscribe = subscribeQueueChanged(refresh);
    const onVisible = () => { if (document.visibilityState === 'visible') void flushNow(); };
    window.addEventListener('online', flushNow);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(flushNow, SENDER_INTERVAL_MS);
    void flushNow();
    return () => {
      unsubscribe();
      window.removeEventListener('online', flushNow);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [refresh, flushNow]);

  return { ...stats, flushing, flushNow };
}
