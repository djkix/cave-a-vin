import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { ApiError } from './api-client';

export interface QueuedPhoto {
  id: string;
  blob: Blob;
  bytes: number;
  createdAt: number;
  mode: 'entry' | 'single' | 'campaign';
  /**
   * Compte qui a pris la photo : seule sa session l'envoie. Absent pour une
   * photo rangée avant les caves multiples (voir `belongsTo`).
   */
  userId?: string;
}

/**
 * Une photo part avec le compte qui l'a prise. Une photo sans estampille date
 * d'avant cette version (téléphone de Franck, seul compte jusque-là) : elle est
 * envoyée par le premier compte propriétaire qui vide la file — compatibilité
 * ascendante voulue.
 */
export function belongsTo(item: QueuedPhoto, userId: string): boolean {
  return item.userId === undefined || item.userId === userId;
}

interface CaveDB extends DBSchema {
  photos: { key: string; value: QueuedPhoto; indexes: { byCreated: number } };
}

export const QUEUE_LIMITS = { maxItems: 200, maxBytes: 200 * 1024 * 1024 };

export class QueueFullError extends Error {
  constructor() {
    super('File d’envoi pleine (200 photos) — attendez que les envois partent');
  }
}

const listeners = new Set<() => void>();

/** Signale que la file a changé (ajout, retrait) pour rafraîchir l'affichage. */
export function notifyQueueChanged(): void {
  listeners.forEach((l) => l());
}

/** S'abonne aux changements de la file ; renvoie une fonction de désabonnement. */
export function subscribeQueueChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Un envoi qui échouera peut-être mieux plus tard : réseau coupé (fetch jette un
 * TypeError), api momentanément indisponible (5xx — dont le 503 que renvoie le
 * rollback de la mise en file côté serveur) ou limiteur de débit (429).
 * Tout le reste est un refus déterministe : inutile de mettre la photo en attente.
 */
export function isRetryableUploadError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  return e instanceof ApiError && (e.status >= 500 || e.status === 429);
}

let dbPromise: Promise<IDBPDatabase<CaveDB>> | null = null;

function db() {
  dbPromise ??= openDB<CaveDB>('cave-offline', 1, {
    upgrade(d) {
      const store = d.createObjectStore('photos', { keyPath: 'id' });
      store.createIndex('byCreated', 'createdAt');
    },
  });
  return dbPromise;
}

export async function listQueue(): Promise<QueuedPhoto[]> {
  return (await db()).getAllFromIndex('photos', 'byCreated');
}

/**
 * Sans compte : toute la file. Avec un compte : ses photos (et les anciennes sans
 * estampille) dans `count`/`bytes`, celles des autres comptes dans `others`.
 */
export async function queueStats(userId?: string | null): Promise<{ count: number; bytes: number; others: number }> {
  const all = await listQueue();
  const mine = userId ? all.filter((p) => belongsTo(p, userId)) : all;
  return { count: mine.length, bytes: mine.reduce((s, p) => s + p.bytes, 0), others: all.length - mine.length };
}

export async function enqueuePhoto(blob: Blob, mode: QueuedPhoto['mode'], userId?: string): Promise<QueuedPhoto> {
  // Les limites protègent le téléphone : elles portent sur toute la file, tous comptes confondus.
  const { count, bytes } = await queueStats();
  if (count >= QUEUE_LIMITS.maxItems || bytes + blob.size > QUEUE_LIMITS.maxBytes) throw new QueueFullError();
  const item: QueuedPhoto = { id: crypto.randomUUID(), blob, bytes: blob.size, createdAt: Date.now(), mode, ...(userId ? { userId } : {}) };
  await (await db()).put('photos', item);
  return item;
}

export async function removeFromQueue(id: string): Promise<void> {
  await (await db()).delete('photos', id);
}

/**
 * Envoie les photos du compte `userId` (et les anciennes sans estampille). Celles
 * d'un autre compte restent dans la file, intactes : jamais envoyées dans la cave
 * d'un autre, jamais effacées.
 */
export async function flushQueue(upload: (blob: Blob) => Promise<unknown>, userId: string): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const item of (await listQueue()).filter((p) => belongsTo(p, userId))) {
    try {
      await upload(item.blob);
      await removeFromQueue(item.id);
      sent++;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403 && e.status !== 429) {
        // Deterministically rejected by the server (bad format, too large…): retrying
        // won't help, and it must not block the rest of the queue. A 429 is the
        // opposite — the limiter asks us to come back later, so it stays queued.
        await removeFromQueue(item.id);
        failed++;
        continue;
      }
      // Network failure, a session problem (401/403), a 429 or a 5xx: stop here, keep
      // this item and everything after it for the next flush attempt.
      return { sent, failed: failed + 1 };
    }
  }
  return { sent, failed };
}

export async function _resetForTests(): Promise<void> {
  await (await db()).clear('photos');
}
