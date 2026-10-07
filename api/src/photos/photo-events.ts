import { Photo } from '@prisma/client';
import { Observable } from 'rxjs';
import { parseExtraction } from '../vision/extraction-schema';

export interface PhotoEvent {
  data: { status: string; extraction?: unknown; errorMessage?: string | null };
}

/** Ce que le flux écoute : les événements `completed` / `failed` de la file d'analyse (QueueEvents). */
export interface JobEventSource {
  on(event: 'completed' | 'failed', listener: (args: { jobId: string }) => void): unknown;
  off(event: 'completed' | 'failed', listener: (args: { jobId: string }) => void): unknown;
}

/**
 * Flux d'une seule photo, déjà vérifiée dans la cave courante à l'ouverture.
 * Seul un travail de cette photo déclenche un envoi (l'identifiant du travail
 * est celui de la photo) ; le contenu est relu par `load`, qui cherche la photo
 * dans la cave : rien d'une autre cave ne peut passer dans la réponse.
 */
export function photoEventStream(
  events: JobEventSource,
  photoId: string,
  load: () => Promise<Pick<Photo, 'status' | 'errorMessage' | 'rawExtraction'>>,
): Observable<PhotoEvent> {
  return new Observable((subscriber) => {
    const emit = async () => {
      const photo = await load();
      const data: PhotoEvent['data'] = { status: photo.status, errorMessage: photo.errorMessage };
      if (photo.status === 'DONE' && photo.rawExtraction) data.extraction = parseExtraction(photo.rawExtraction);
      subscriber.next({ data });
      if (photo.status === 'DONE' || photo.status === 'FAILED') subscriber.complete();
    };
    const safeEmit = () => {
      emit().catch((e) => subscriber.error(e));
    };
    const onDone = ({ jobId }: { jobId: string }) => {
      if (jobId === photoId) safeEmit();
    };
    events.on('completed', onDone);
    events.on('failed', onDone);
    safeEmit();
    return () => {
      events.off('completed', onDone);
      events.off('failed', onDone);
    };
  });
}
