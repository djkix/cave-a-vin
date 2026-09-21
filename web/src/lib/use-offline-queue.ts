import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadPhoto } from './api-client';
import { flushQueue, queueStats } from './offline-queue';

const listeners = new Set<() => void>();
export function notifyQueueChanged() {
  listeners.forEach((l) => l());
}

export function useOfflineQueue() {
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [flushing, setFlushing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(() => void queueStats().then(setStats), []);

  const flushNow = useCallback(async () => {
    if (inFlight.current || !navigator.onLine) return;
    inFlight.current = true;
    setFlushing(true);
    try {
      await flushQueue(uploadPhoto);
    } finally {
      inFlight.current = false;
      setFlushing(false);
      notifyQueueChanged();
    }
  }, []);

  useEffect(() => {
    refresh();
    listeners.add(refresh);
    const onVisible = () => { if (document.visibilityState === 'visible') void flushNow(); };
    window.addEventListener('online', flushNow);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(flushNow, 60_000);
    void flushNow();
    return () => {
      listeners.delete(refresh);
      window.removeEventListener('online', flushNow);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [refresh, flushNow]);

  return { ...stats, flushing, flushNow };
}
