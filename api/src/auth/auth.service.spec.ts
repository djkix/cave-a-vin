import { ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

function fakePrisma() {
  const users = new Map<string, any>();
  const allowed = new Set<string>();
  return {
    allowed,
    allowedEmail: { findUnique: async ({ where }: any) => (allowed.has(where.email) ? { email: where.email } : null) },
    appUser: {
      findUnique: async ({ where }: any) => {
        for (const u of users.values()) {
          if ((where.googleSub && u.googleSub === where.googleSub) || (where.email && u.email === where.email)) return u;
        }
        return null;
      },
      create: async ({ data }: any) => {
        const u = { id: `u${users.size + 1}`, ...data };
        users.set(u.id, u);
        return u;
      },
      update: async ({ where, data }: any) => {
        const u = [...users.values()].find((x) => x.id === where.id);
        Object.assign(u, data);
        return u;
      },
    },
  };
}

describe('AuthService', () => {
  it('refuses a Google account whose email is not whitelisted', async () => {
    const prisma = fakePrisma();
    const service = new AuthService(prisma as any);
    await expect(
      service.findOrCreateGoogleUser({ sub: '123', email: 'x@example.com', displayName: 'X' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates then reuses a whitelisted Google user, keyed by sub', async () => {
    const prisma = fakePrisma();
    prisma.allowed.add('franck@example.com');
    const service = new AuthService(prisma as any);
    const first = await service.findOrCreateGoogleUser({ sub: '123', email: 'franck@example.com', displayName: 'Franck' });
    const second = await service.findOrCreateGoogleUser({ sub: '123', email: 'new@example.com', displayName: 'Franck' });
    expect(second.id).toBe(first.id);
  });

  it('verifies the break-glass password with argon2', async () => {
    const prisma = fakePrisma();
    const hash = await argon2.hash('correct horse battery');
    await prisma.appUser.create({ data: { email: 'bg@example.com', isBreakGlass: true, passwordHash: hash } });
    const service = new AuthService(prisma as any);
    expect(await service.verifyLocalLogin('bg@example.com', 'wrong')).toBeNull();
    expect((await service.verifyLocalLogin('bg@example.com', 'correct horse battery'))?.email).toBe('bg@example.com');
  });
});
