import { ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

// ADMIN_EMAILS est imposé, pas complété : l'intégration continue définit sa
// propre valeur pour la spec HTTP, qui écraserait le scénario de ce fichier si
// on se contentait de `??=`. adminEmailsFromEnv() relit process.env à chaque
// appel, cette affectation est donc bien celle qui compte.
process.env.DATABASE_URL ??= 'postgresql://postgres:dev@localhost:5432/cave';
process.env.SESSION_SECRET ??= 'a'.repeat(32);
process.env.ADMIN_EMAILS = 'admin@example.com';

function fakePrisma() {
  const users = new Map<string, any>();
  return {
    users,
    appUser: {
      findUnique: async ({ where }: any) => {
        for (const u of users.values()) {
          if ((where.googleSub && u.googleSub === where.googleSub) || (where.email && u.email === where.email)) return u;
        }
        return null;
      },
      create: async ({ data }: any) => {
        const u = { id: `u${users.size + 1}`, status: 'ACTIVE', isAdmin: false, ...data };
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
  it('creates a Google account for any e-mail (inscription libre) and gives immediate access', async () => {
    const prisma = fakePrisma();
    const service = new AuthService(prisma as any);
    const user = await service.findOrCreateGoogleUser({ sub: '123', email: 'x@example.com', displayName: 'X' });
    expect(user.email).toBe('x@example.com');
    expect(user.status).toBe('ACTIVE');
  });

  it('creates then reuses a Google user, keyed by sub', async () => {
    const prisma = fakePrisma();
    const service = new AuthService(prisma as any);
    const first = await service.findOrCreateGoogleUser({ sub: '123', email: 'franck@example.com', displayName: 'Franck' });
    const second = await service.findOrCreateGoogleUser({ sub: '123', email: 'new@example.com', displayName: 'Franck' });
    expect(second.id).toBe(first.id);
  });

  it('links a Google sign-in to an existing local account with the same e-mail (no google_sub yet)', async () => {
    const prisma = fakePrisma();
    const preexisting = await prisma.appUser.create({
      data: { email: 'owner@example.com', isBreakGlass: true, passwordHash: 'hash', googleSub: null },
    });
    expect(preexisting.googleSub).toBeNull();
    const service = new AuthService(prisma as any);

    const linked = await service.findOrCreateGoogleUser({ sub: '999', email: 'owner@example.com', displayName: 'Owner' });

    expect(linked.id).toBe(preexisting.id);
    expect(linked.googleSub).toBe('999');
    expect(prisma.users.size).toBe(1);
  });

  it('marks a user admin when its e-mail is in ADMIN_EMAILS, re-derived on every login', async () => {
    const prisma = fakePrisma();
    const service = new AuthService(prisma as any);
    const user = await service.findOrCreateGoogleUser({ sub: '1', email: 'admin@example.com', displayName: 'Admin' });
    expect(user.isAdmin).toBe(true);
  });

  it('does not mark a user admin when its e-mail is absent from ADMIN_EMAILS', async () => {
    const prisma = fakePrisma();
    const service = new AuthService(prisma as any);
    const user = await service.findOrCreateGoogleUser({ sub: '2', email: 'nobody@example.com', displayName: 'Nobody' });
    expect(user.isAdmin).toBe(false);
  });

  it('keeps a promotion made from /admin on a later login, even when the e-mail is absent from ADMIN_EMAILS', async () => {
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'promoted@example.com', googleSub: 'g-promoted', isAdmin: true } });
    const service = new AuthService(prisma as any);

    const user = await service.findOrCreateGoogleUser({ sub: 'g-promoted', email: 'promoted@example.com', displayName: 'Promoted' });

    expect(user.isAdmin).toBe(true);
  });

  it('grants isAdmin for an ADMIN_EMAILS address even when the database still says false (ADMIN_EMAILS is a floor, not a ceiling)', async () => {
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'admin@example.com', googleSub: 'g-admin', isAdmin: false } });
    const service = new AuthService(prisma as any);

    const user = await service.findOrCreateGoogleUser({ sub: 'g-admin', email: 'admin@example.com', displayName: 'Admin' });

    expect(user.isAdmin).toBe(true);
  });

  it('sets lastLoginAt on a Google sign-in', async () => {
    const prisma = fakePrisma();
    const service = new AuthService(prisma as any);
    const user = await service.findOrCreateGoogleUser({ sub: '1', email: 'a@example.com', displayName: 'A' });
    expect(user.lastLoginAt).toBeInstanceOf(Date);
  });

  it('refuses a blocked Google account after updating lastLoginAt, without ever handing out a session', async () => {
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'blocked@example.com', googleSub: 'g1', status: 'BLOCKED' } });
    const service = new AuthService(prisma as any);
    await expect(
      service.findOrCreateGoogleUser({ sub: 'g1', email: 'blocked@example.com', displayName: 'Blocked' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const stored = [...prisma.users.values()][0];
    expect(stored.lastLoginAt).toBeInstanceOf(Date);
  });

  it('verifies the break-glass password with argon2', async () => {
    const prisma = fakePrisma();
    const hash = await argon2.hash('correct horse battery');
    await prisma.appUser.create({ data: { email: 'bg@example.com', isBreakGlass: true, passwordHash: hash } });
    const service = new AuthService(prisma as any);
    expect(await service.verifyLocalLogin('bg@example.com', 'wrong')).toBeNull();
    expect((await service.verifyLocalLogin('bg@example.com', 'correct horse battery'))?.email).toBe('bg@example.com');
  });

  it('refuses a blocked local (break-glass) account even with the right password', async () => {
    const prisma = fakePrisma();
    const hash = await argon2.hash('correct horse battery');
    await prisma.appUser.create({ data: { email: 'bg@example.com', isBreakGlass: true, passwordHash: hash, status: 'BLOCKED' } });
    const service = new AuthService(prisma as any);
    expect(await service.verifyLocalLogin('bg@example.com', 'correct horse battery')).toBeNull();
  });
});
