import type { PhotoEvent } from './api-client';

export function subscribePhotoEvents(photoId: string, onEvent: (e: PhotoEvent) => void, onError?: () => void): () => void {
  const source = new EventSource(`/api/photos/${photoId}/events`, { withCredentials: true });
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data) as PhotoEvent;
    onEvent(e);
    if (e.status === 'DONE' || e.status === 'FAILED') source.close();
  };
  source.onerror = () => { source.close(); onError?.(); };
  return () => source.close();
}
