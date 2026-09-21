import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppUser } from '@prisma/client';
import { AdminService } from './admin.service';

function fakePrisma() {
  const users = new Map<string, any>();
  return {
    users,
    appUser: {
      findMany: async ({ orderBy }: any) => {
        const list = [...users.values()];
        if (orderBy?.createdAt === 'desc') list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return list;
      },
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const u = users.get(where.id);
        Object.assign(u, data);
        return u;
      },
    },
  };
}

function user(id: string, overrides: Partial<AppUser> = {}): AppUser {
  return {
    id,
    email: `${id}@example.com`,
    displayName: null,
    googleSub: null,
    passwordHash: null,
    isBreakGlass: false,
    status: 'ACTIVE',
    isAdmin: false,
    lastLoginAt: null,
    createdAt: new Date(),
    ...overrides,
  } as AppUser;
}

describe('AdminService', () => {
  it('lists all accounts, most recently created first', async () => {
    const prisma = fakePrisma();
    const older = user('u1', { createdAt: new Date('2026-01-01') });
    const newer = user('u2', { createdAt: new Date('2026-02-01') });
    prisma.users.set(older.id, older);
    prisma.users.set(newer.id, newer);
    const service = new AdminService(prisma as any);

    const list = await service.listUsers();

    expect(list.map((u: AppUser) => u.id)).toEqual(['u2', 'u1']);
  });

  it('refuses to let an admin modify their own account', async () => {
    const prisma = fakePrisma();
    const admin = user('u1', { isAdmin: true });
    prisma.users.set(admin.id, admin);
    const service = new AdminService(prisma as any);

    await expect(service.updateUser('u1', admin, { status: 'BLOCKED' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks another account', async () => {
    const prisma = fakePrisma();
    const admin = user('u1', { isAdmin: true });
    const target = user('u2');
    prisma.users.set(admin.id, admin);
    prisma.users.set(target.id, target);
    const service = new AdminService(prisma as any);

    const updated = await service.updateUser('u2', admin, { status: 'BLOCKED' });

    expect(updated.status).toBe('BLOCKED');
  });

  it('promotes another account to admin', async () => {
    const prisma = fakePrisma();
    const admin = user('u1', { isAdmin: true });
    const target = user('u2');
    prisma.users.set(admin.id, admin);
    prisma.users.set(target.id, target);
    const service = new AdminService(prisma as any);

    const updated = await service.updateUser('u2', admin, { isAdmin: true });

    expect(updated.isAdmin).toBe(true);
  });

  it('reports an unknown account as not found', async () => {
    const prisma = fakePrisma();
    const admin = user('u1', { isAdmin: true });
    prisma.users.set(admin.id, admin);
    const service = new AdminService(prisma as any);

    await expect(service.updateUser('missing', admin, { status: 'BLOCKED' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
