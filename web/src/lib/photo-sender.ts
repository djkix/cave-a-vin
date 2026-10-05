import { uploadPhoto } from './api-client';
import { flushQueue, notifyQueueChanged } from './offline-queue';

let inFlight: Promise<void> | null = null;

/**
 * Vidange la file locale, à vol unique dans toute l'application : si une
 * vidange est déjà en cours, l'appel renvoie la même promesse au lieu d'en
 * démarrer une seconde en parallèle (deux onglets ou deux instances du hook
 * ne doivent jamais envoyer la même photo deux fois).
 */
export function sendQueuedPhotos(): Promise<void> {
  inFlight ??= (async () => {
    try {
      await flushQueue(uploadPhoto);
    } finally {
      inFlight = null;
      notifyQueueChanged();
    }
  })();
  return inFlight;
}

/** Déclenche une vidange sans attendre son résultat (appel « tire et oublie »). */
export function kickSender(): void {
  void sendQueuedPhotos();
}

export function _resetSenderForTests(): void {
  inFlight = null;
}
