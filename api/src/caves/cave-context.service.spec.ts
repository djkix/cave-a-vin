import { CaveContextService } from './cave-context.service';

/** Base factice : un administrateur principal propriétaire de « Cave de Franck ». */
function serviceFor(opts: { isBreakGlass: boolean; members: { id: string; name: string; role: 'OWNER' | 'VIEWER' }[]; mainCave?: boolean }) {
  const prisma = {
    caveMember: { findMany: jest.fn(async () => opts.members.map((c) => ({ role: c.role, cave: { id: c.id, name: c.name } }))) },
    appUser: {
      findUnique: jest.fn(async () => ({ isBreakGlass: opts.isBreakGlass })),
      findFirst: jest.fn(async () => (opts.mainCave === false ? null : { id: 'franck' })),
    },
    cave: {
      findFirst: jest.fn(async () => ({ id: 'principale' })),
      findUnique: jest.fn(async () => ({ id: 'principale', name: 'Cave de Franck' })),
    },
  };
  return new CaveContextService(prisma as never);
}

describe('CaveContextService — compte de secours', () => {
  it('le compte de secours est propriétaire de la cave principale, même inscrit comme membre', async () => {
    const service = serviceFor({ isBreakGlass: true, members: [{ id: 'principale', name: 'Cave de Franck', role: 'VIEWER' }] });
    expect(await service.listForUser('secours')).toEqual([{ id: 'principale', name: 'Cave de Franck', role: 'OWNER' }]);
    expect(await service.findAccess('secours', 'principale')).toEqual({ caveId: 'principale', role: 'OWNER' });
    expect(await service.resolveCurrent('secours')).toEqual({ caveId: 'principale', role: 'OWNER' });
  });

  it('le compte de secours y accède même sans ligne de membre, et garde ses autres caves', async () => {
    const service = serviceFor({ isBreakGlass: true, members: [{ id: 'autre', name: 'Cave d’Ami', role: 'VIEWER' }] });
    expect(await service.listForUser('secours')).toEqual([
      { id: 'principale', name: 'Cave de Franck', role: 'OWNER' },
      { id: 'autre', name: 'Cave d’Ami', role: 'VIEWER' },
    ]);
    expect(await service.findAccess('secours', 'autre')).toEqual({ caveId: 'autre', role: 'VIEWER' });
  });

  it('sans cave principale, le compte de secours n’a que ses lignes de membre', async () => {
    const service = serviceFor({ isBreakGlass: true, mainCave: false, members: [] });
    expect(await service.resolveCurrent('secours')).toBeNull();
  });

  it('un autre compte reste lecteur de la cave principale', async () => {
    const service = serviceFor({ isBreakGlass: false, members: [{ id: 'principale', name: 'Cave de Franck', role: 'VIEWER' }] });
    expect(await service.findAccess('membre', 'principale')).toEqual({ caveId: 'principale', role: 'VIEWER' });
  });
});
