import { EventEmitter } from 'node:events';
import { firstValueFrom, toArray } from 'rxjs';
import { photoEventStream } from './photo-events';

describe('photoEventStream (événements temps réel d’une photo de la cave courante)', () => {
  const photo = (status: string, extra: Record<string, unknown> = {}): any => ({ id: 'p1', caveId: 'c1', status, errorMessage: null, rawExtraction: null, ...extra });

  it('n’émet que pour la photo suivie : un travail d’une autre photo (d’une autre cave) ne déclenche rien', async () => {
    const events = new EventEmitter();
    const load = jest.fn(async () => photo('PROCESSING'));
    const received: unknown[] = [];
    const sub = photoEventStream(events, 'p1', load).subscribe((e) => received.push(e));
    await new Promise((r) => setImmediate(r));
    expect(load).toHaveBeenCalledTimes(1);

    events.emit('completed', { jobId: 'p-autre-cave' });
    events.emit('failed', { jobId: 'p-autre-cave' });
    await new Promise((r) => setImmediate(r));
    expect(load).toHaveBeenCalledTimes(1);
    expect(received).toEqual([{ data: { status: 'PROCESSING', errorMessage: null } }]);
    sub.unsubscribe();
    expect(events.listenerCount('completed')).toBe(0);
    expect(events.listenerCount('failed')).toBe(0);
  });

  it('relit la photo dans la cave à chaque événement et se termine quand elle est analysée', async () => {
    const events = new EventEmitter();
    const load = jest.fn().mockResolvedValueOnce(photo('PROCESSING')).mockResolvedValueOnce(photo('FAILED', { errorMessage: 'illisible' }));
    const all = firstValueFrom(photoEventStream(events, 'p1', load).pipe(toArray()));
    await new Promise((r) => setImmediate(r));
    events.emit('failed', { jobId: 'p1' });
    expect(await all).toEqual([
      { data: { status: 'PROCESSING', errorMessage: null } },
      { data: { status: 'FAILED', errorMessage: 'illisible' } },
    ]);
  });

  it('photo devenue introuvable dans la cave : le flux s’arrête en erreur, sans rien émettre', async () => {
    const events = new EventEmitter();
    const load = jest.fn(async () => {
      throw new Error('Photo introuvable');
    });
    await expect(firstValueFrom(photoEventStream(events, 'p1', load).pipe(toArray()))).rejects.toThrow('Photo introuvable');
  });
});
