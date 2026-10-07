import { uploadPhoto } from './api-client';
import { flushQueue, notifyQueueChanged } from './offline-queue';

let inFlight: Promise<void> | null = null;
// Compte dont la file part : le propriétaire connecté, posé par useBackgroundSender.
// Nul (déconnecté, membre en lecture seule, compte en attente) : rien ne part.
let account: string | null = null;

export function setSenderAccount(userId: string | null): void {
  account = userId;
}

/**
 * Vidange la file locale, à vol unique dans toute l'application : si une
 * vidange est déjà en cours, l'appel renvoie la même promesse au lieu d'en
 * démarrer une seconde en parallèle (deux onglets ou deux instances du hook
 * ne doivent jamais envoyer la même photo deux fois).
 */
export function sendQueuedPhotos(): Promise<void> {
  const owner = account;
  if (!owner) return Promise.resolve();
  inFlight ??= (async () => {
    try {
      await flushQueue(uploadPhoto, owner);
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
  account = null;
}
