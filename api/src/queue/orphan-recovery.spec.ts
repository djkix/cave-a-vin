import { requeueOrphanPhotos } from './orphan-recovery';

function harness(photos: { id: string }[], jobs: Record<string, { state: string; removable?: boolean }> = {}) {
  const added: string[] = [];
  const removed: string[] = [];
  const prisma = { photo: { findMany: jest.fn(async () => photos) } };
  const queue = {
    getJob: jest.fn(async (id: string) => {
      const job = jobs[id];
      if (!job) return undefined;
      return {
        getState: async () => job.state,
        remove: async () => {
          if (job.removable === false) throw new Error('job is locked');
          removed.push(id);
        },
      };
    }),
    add: jest.fn(async (_name: string, data: { photoId: string }) => {
      added.push(data.photoId);
      return {} as never;
    }),
  };
  return { prisma, queue, added, removed };
}

describe('requeueOrphanPhotos', () => {
  it('remet en file une photo en attente dont le travail a disparu avec Redis', async () => {
    const h = harness([{ id: 'p1' }]);
    expect(await requeueOrphanPhotos(h.prisma, h.queue as never)).toBe(1);
    expect(h.added).toEqual(['p1']);
  });

  it('ne cherche que les photos en attente ou en cours', async () => {
    const h = harness([]);
    await requeueOrphanPhotos(h.prisma, h.queue as never);
    expect(h.prisma.photo.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }));
  });

  it.each(['waiting', 'delayed', 'active', 'prioritized'])('laisse tranquille une photo dont le travail est %s', async (state) => {
    const h = harness([{ id: 'p1' }], { p1: { state } });
    expect(await requeueOrphanPhotos(h.prisma, h.queue as never)).toBe(0);
    expect(h.added).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  it('supprime l’ancien travail terminé avant de remettre en file, sinon l’ajout serait ignoré', async () => {
    const h = harness([{ id: 'p1' }], { p1: { state: 'failed' } });
    expect(await requeueOrphanPhotos(h.prisma, h.queue as never)).toBe(1);
    expect(h.removed).toEqual(['p1']);
    expect(h.added).toEqual(['p1']);
  });

  it('réutilise l’identifiant de la photo comme identifiant de travail, pour rester idempotent', async () => {
    const h = harness([{ id: 'p1' }]);
    await requeueOrphanPhotos(h.prisma, h.queue as never);
    expect(h.queue.add).toHaveBeenCalledWith('extract', { photoId: 'p1' }, { jobId: 'p1' });
  });

  it('passe à la photo suivante quand un ancien travail refuse d’être supprimé', async () => {
    const h = harness([{ id: 'p1' }, { id: 'p2' }], { p1: { state: 'failed', removable: false } });
    const messages: string[] = [];
    expect(await requeueOrphanPhotos(h.prisma, h.queue as never, (m) => messages.push(m))).toBe(1);
    expect(h.added).toEqual(['p2']);
    expect(messages.some((m) => m.includes('p1'))).toBe(true);
  });

  it('ne dit rien quand il n’y a rien à reprendre', async () => {
    const h = harness([]);
    const messages: string[] = [];
    expect(await requeueOrphanPhotos(h.prisma, h.queue as never, (m) => messages.push(m))).toBe(0);
    expect(messages).toEqual([]);
  });
});
