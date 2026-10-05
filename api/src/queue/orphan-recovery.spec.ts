import { requeueOrphanPhotos } from './orphan-recovery';

function harness(photos: { id: string }[]) {
  const updated: { id: string; data: any }[] = [];
  const prisma = {
    photo: {
      findMany: jest.fn(async () => photos),
      update: jest.fn(async ({ where, data }: any) => {
        updated.push({ id: where.id, data });
        return {};
      }),
    },
  };
  return { prisma, updated };
}

describe('requeueOrphanPhotos', () => {
  it('ne sélectionne que les photos de sortie restées en attente ou en cours', async () => {
    const h = harness([]);
    await requeueOrphanPhotos(h.prisma as never);
    expect(h.prisma.photo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ['PENDING', 'PROCESSING'] }, purpose: 'EXIT' } }),
    );
  });

  it('abandonne chaque photo de sortie trouvée : l’utilisateur n’est plus devant la bouteille après un redémarrage', async () => {
    const h = harness([{ id: 'p1' }, { id: 'p2' }]);
    expect(await requeueOrphanPhotos(h.prisma as never)).toBe(2);
    expect(h.updated).toEqual([
      { id: 'p1', data: { status: 'FAILED', errorMessage: 'Photo de sortie abandonnée au redémarrage' } },
      { id: 'p2', data: { status: 'FAILED', errorMessage: 'Photo de sortie abandonnée au redémarrage' } },
    ]);
  });

  it('ne dit rien quand il n’y a rien à abandonner', async () => {
    const h = harness([]);
    const messages: string[] = [];
    expect(await requeueOrphanPhotos(h.prisma as never, (m) => messages.push(m))).toBe(0);
    expect(messages).toEqual([]);
  });

  it('journalise le nombre de photos de sortie abandonnées', async () => {
    const h = harness([{ id: 'p1' }]);
    const messages: string[] = [];
    await requeueOrphanPhotos(h.prisma as never, (m) => messages.push(m));
    expect(messages.some((m) => m.includes('1'))).toBe(true);
  });
});
