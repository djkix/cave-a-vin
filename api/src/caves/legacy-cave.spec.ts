import { resolveLegacyCaveId } from './legacy-cave';

function fakePrisma(opts: { caves?: { id: string; ownerId?: string | null }[]; admin?: object | null; breakGlass?: object | null } = {}) {
  const caves = [...(opts.caves ?? [])];
  const created: any[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async () => 1),
    cave: {
      // Caves rangées de la plus ancienne à la plus récente.
      findFirst: jest.fn(async ({ where }: any = {}) => caves.find((c) => !where?.ownerId || c.ownerId) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const cave = { id: 'nouvelle', ...data };
        created.push(cave);
        caves.push(cave);
        return cave;
      }),
    },
    appUser: {
      findFirst: jest.fn(async ({ where }: any) => (where.isBreakGlass ? opts.breakGlass ?? null : opts.admin ?? null)),
    },
  };
  const prisma: any = { ...tx, $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { prisma, tx, created };
}

describe('resolveLegacyCaveId (transition mono-cave → multi-caves)', () => {
  it('préfère la plus ancienne cave qui a un propriétaire (une cave de test n’en a pas)', async () => {
    const { prisma, created } = fakePrisma({ caves: [{ id: 'essai', ownerId: null }, { id: 'franck', ownerId: 'u1' }] });
    expect(await resolveLegacyCaveId(prisma)).toBe('franck');
    expect(prisma.cave.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: { not: null } } }));
    expect(created).toEqual([]);
  });

  it('sinon la plus ancienne cave existante, sans rien créer', async () => {
    const { prisma, created } = fakePrisma({ caves: [{ id: 'c1', ownerId: null }] });
    expect(await resolveLegacyCaveId(prisma)).toBe('c1');
    expect(prisma.cave.findFirst).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it('sans cave : la crée pour le premier administrateur (hors secours), avec sa ligne OWNER, sous verrou', async () => {
    const { prisma, tx, created } = fakePrisma({ admin: { id: 'u1', email: 'franck@example.com', displayName: 'Franck' } });
    expect(await resolveLegacyCaveId(prisma)).toBe('nouvelle');
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.appUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE', isAdmin: true, isBreakGlass: false }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    );
    expect(created).toEqual([
      expect.objectContaining({ name: 'Cave de Franck', ownerId: 'u1', members: { create: { userId: 'u1', role: 'OWNER' } } }),
    ]);
  });

  it('sinon le compte de secours, nommé par son adresse', async () => {
    const { prisma, created } = fakePrisma({ admin: null, breakGlass: { id: 'bg', email: 'secours@example.com', displayName: ' ' } });
    await resolveLegacyCaveId(prisma);
    expect(created[0]).toEqual(expect.objectContaining({ name: 'Cave de secours@example.com', ownerId: 'bg' }));
  });

  it('sans aucun compte : cave sans propriétaire', async () => {
    const { prisma, created } = fakePrisma();
    await resolveLegacyCaveId(prisma);
    expect(created).toEqual([{ id: 'nouvelle', name: 'Ma cave', ownerId: null }]);
  });

  it('une cave créée entre-temps par une autre requête est reprise, pas doublée', async () => {
    const { prisma, tx, created } = fakePrisma({ admin: { id: 'u1', email: 'a@example.com', displayName: null } });
    prisma.cave.findFirst = jest.fn(async () => null);
    tx.cave.findFirst = jest.fn(async () => ({ id: 'concurrente' }));
    expect(await resolveLegacyCaveId(prisma)).toBe('concurrente');
    expect(created).toEqual([]);
  });
});
