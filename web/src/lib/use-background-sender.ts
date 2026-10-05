import { useEffect } from 'react';
import { queueStats, subscribeQueueChanged } from './offline-queue';
import { sendQueuedPhotos } from './photo-sender';

const SENDER_INTERVAL_MS = 15_000;

/**
 * Envoi en arrière-plan des photos restées sur le téléphone, actif sur toute
 * page de l'application une fois connecté (monté une seule fois, à la racine
 * des pages protégées) : au montage, au retour du réseau, quand l'application
 * redevient visible, et toutes les 15 s tant que la file n'est pas vide.
 */
export function useBackgroundSender(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let active = true;

    const send = () => {
      if (!navigator.onLine) return;
      // L'échec d'une vidange est sans conséquence : la photo reste dans la file
      // et repartira au prochain déclencheur.
      sendQueuedPhotos().catch(() => undefined);
    };
    const armTimer = () =>
      void queueStats().then(({ count }) => {
        if (!active) return;
        if (count > 0 && timer === undefined) timer = window.setInterval(send, SENDER_INTERVAL_MS);
        if (count === 0 && timer !== undefined) {
          window.clearInterval(timer);
          timer = undefined;
        }
      });
    const onVisible = () => {
      if (document.visibilityState === 'visible') send();
    };

    const unsubscribe = subscribeQueueChanged(armTimer);
    window.addEventListener('online', send);
    document.addEventListener('visibilitychange', onVisible);
    send();
    armTimer();
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('online', send);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled]);
}
