import { CavesService, caveNameFor } from './caves.service';

describe('caveNameFor', () => {
  it('« Cave de {nom affiché} », sinon l’adresse', () => {
    expect(caveNameFor({ email: 'a@example.com', displayName: ' Franck ' })).toBe('Cave de Franck');
    expect(caveNameFor({ email: 'a@example.com', displayName: '  ' })).toBe('Cave de a@example.com');
    expect(caveNameFor({ email: 'a@example.com', displayName: null })).toBe('Cave de a@example.com');
  });
});

function fakePrisma(opts: { owned?: boolean; orphans?: { id: string }[]; claimable?: string[]; membership?: { id: string } | null } = {}) {
  const claimable = new Set(opts.claimable ?? (opts.orphans ?? []).map((o) => o.id));
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: 'u1' }]),
    cave: {
      count: jest.fn(async ({ where }: any) => (where.ownerId === null ? (opts.orphans ?? []).length : 0)),
      findFirst: jest.fn(async ({ where }: any) => (where.ownerId === 'u1' ? (opts.owned ? { id: 'own' } : null) : null)),
      findMany: jest.fn(async () => opts.orphans ?? []),
      updateMany: jest.fn(async ({ where }: any) => ({ count: claimable.has(where.id) ? 1 : 0 })),
      create: jest.fn(async ({ data }: any) => ({ id: 'created', ...data })),
    },
    caveMember: {
      findUnique: jest.fn(async () => opts.membership ?? null),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
    },
  };
  const prisma: any = { ...tx, $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { prisma, tx };
}

describe('CavesService.claimOrphanCave (cave migrée sans propriétaire)', () => {
  it('attribue la plus ancienne cave sans propriétaire, par mise à jour conditionnelle, avec une ligne OWNER', async () => {
    const { prisma, tx } = fakePrisma({ orphans: [{ id: 'c1' }, { id: 'c2' }] });
    expect(await new CavesService(prisma).claimOrphanCave('u1')).toBe('c1');
    expect(tx.$queryRaw).toHaveBeenCalled(); // verrou sur le compte
    expect(tx.cave.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    );
    expect(tx.cave.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', ownerId: null }, data: { ownerId: 'u1' } });
    expect(tx.caveMember.create).toHaveBeenCalledWith({ data: { caveId: 'c1', userId: 'u1', role: 'OWNER' } });
  });

  it('passe à la suivante si une autre connexion l’a prise entre-temps', async () => {
    const { prisma, tx } = fakePrisma({ orphans: [{ id: 'c1' }, { id: 'c2' }], claimable: ['c2'] });
    expect(await new CavesService(prisma).claimOrphanCave('u1')).toBe('c2');
    expect(tx.caveMember.create).toHaveBeenCalledWith({ data: { caveId: 'c2', userId: 'u1', role: 'OWNER' } });
  });

  it('promeut en OWNER un compte déjà membre de la cave', async () => {
    const { prisma, tx } = fakePrisma({ orphans: [{ id: 'c1' }], membership: { id: 'm1' } });
    await new CavesService(prisma).claimOrphanCave('u1');
    expect(tx.caveMember.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: 'OWNER' } });
    expect(tx.caveMember.create).not.toHaveBeenCalled();
  });

  it('ne fait rien si le compte a déjà une cave', async () => {
    const { prisma, tx } = fakePrisma({ owned: true, orphans: [{ id: 'c1' }] });
    expect(await new CavesService(prisma).claimOrphanCave('u1')).toBeNull();
    expect(tx.cave.updateMany).not.toHaveBeenCalled();
  });

  it('sans cave orpheline, n’ouvre même pas de transaction (connexion admin gratuite)', async () => {
    const { prisma, tx } = fakePrisma({ orphans: [] });
    expect(await new CavesService(prisma).claimOrphanCave('u1')).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.caveMember.create).not.toHaveBeenCalled();
  });

  it('parcourt toutes les orphelines, sans abandonner après quelques courses perdues', async () => {
    const orphans = Array.from({ length: 8 }, (_, i) => ({ id: `c${i + 1}` }));
    const { prisma, tx } = fakePrisma({ orphans, claimable: ['c8'] });
    expect(await new CavesService(prisma).claimOrphanCave('u1')).toBe('c8');
    expect(tx.cave.updateMany).toHaveBeenCalledTimes(8);
    expect(tx.cave.findMany.mock.calls[0][0]).not.toHaveProperty('take');
  });
});

describe('CavesService.createOwnedCave', () => {
  it('crée « Cave de … » avec sa ligne OWNER', async () => {
    const { prisma, tx } = fakePrisma();
    await new CavesService(prisma).createOwnedCave(tx, { id: 'u1', email: 'a@example.com', displayName: 'Anne' });
    expect(tx.cave.create).toHaveBeenCalledWith({
      data: { name: 'Cave de Anne', ownerId: 'u1', members: { create: { userId: 'u1', role: 'OWNER' } } },
    });
  });
});
