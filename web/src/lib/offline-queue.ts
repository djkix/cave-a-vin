import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { ApiError } from './api-client';

export interface QueuedPhoto {
  id: string;
  blob: Blob;
  bytes: number;
  createdAt: number;
  mode: 'single' | 'campaign';
}

interface CaveDB extends DBSchema {
  photos: { key: string; value: QueuedPhoto; indexes: { byCreated: number } };
}

export const QUEUE_LIMITS = { maxItems: 20, maxBytes: 50 * 1024 * 1024 };

export class QueueFullError extends Error {
  constructor() {
    super('File hors ligne pleine (20 photos / 50 Mo) — envoyez les photos en attente avant d’en prendre d’autres');
  }
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

export async function queueStats(): Promise<{ count: number; bytes: number }> {
  const all = await listQueue();
  return { count: all.length, bytes: all.reduce((s, p) => s + p.bytes, 0) };
}

export async function enqueuePhoto(blob: Blob, mode: QueuedPhoto['mode']): Promise<QueuedPhoto> {
  const { count, bytes } = await queueStats();
  if (count >= QUEUE_LIMITS.maxItems || bytes + blob.size > QUEUE_LIMITS.maxBytes) throw new QueueFullError();
  const item: QueuedPhoto = { id: crypto.randomUUID(), blob, bytes: blob.size, createdAt: Date.now(), mode };
  await (await db()).put('photos', item);
  return item;
}

export async function removeFromQueue(id: string): Promise<void> {
  await (await db()).delete('photos', id);
}

export async function flushQueue(upload: (blob: Blob) => Promise<unknown>): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const item of await listQueue()) {
    try {
      await upload(item.blob);
      await removeFromQueue(item.id);
      sent++;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403) {
        // Deterministically rejected by the server (bad format, too large…): retrying
        // won't help, and it must not block the rest of the queue.
        await removeFromQueue(item.id);
        failed++;
        continue;
      }
      // Network failure or a session problem (401/403) or a 5xx: stop here, keep this
      // item and everything after it for the next flush attempt.
      return { sent, failed: failed + 1 };
    }
  }
  return { sent, failed };
}

export async function _resetForTests(): Promise<void> {
  await (await db()).clear('photos');
}
