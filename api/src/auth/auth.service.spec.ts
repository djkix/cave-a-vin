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

function fakePrisma(invitations: { id: string; invitedEmail: string | null; userId: string | null }[] = []) {
  const users = new Map<string, any>();
  const prisma: any = {
    users,
    invitations,
    caveMember: {
      count: async ({ where }: any) => invitations.filter((i) => i.invitedEmail === where.invitedEmail && i.userId === where.userId).length,
      updateMany: async ({ where, data }: any) => {
        const hits = invitations.filter((i) => i.invitedEmail === where.invitedEmail && i.userId === where.userId);
        hits.forEach((i) => Object.assign(i, data));
        return { count: hits.length };
      },
    },
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
  prisma.$transaction = async (fn: any) => fn(prisma);
  return prisma;
}

function fakeCaves() {
  return { claimOrphanCave: jest.fn(async () => null) };
}

function serviceWith(prisma: any, caves = fakeCaves()) {
  return new AuthService(prisma, caves as any);
}

describe('AuthService', () => {
  it('creates an unknown Google address as PENDING (inscription à valider)', async () => {
    const prisma = fakePrisma();
    const service = serviceWith(prisma);
    const user = await service.findOrCreateGoogleUser({ sub: '123', email: 'X@example.com', displayName: 'X' });
    expect(user.email).toBe('x@example.com');
    expect(user.status).toBe('PENDING');
    expect(user.isAdmin).toBe(false);
  });

  it('creates an ADMIN_EMAILS address as ACTIVE administrator', async () => {
    const prisma = fakePrisma();
    const user = await serviceWith(prisma).findOrCreateGoogleUser({ sub: '1', email: 'admin@example.com', displayName: 'Admin' });
    expect(user.status).toBe('ACTIVE');
    expect(user.isAdmin).toBe(true);
  });

  it('creates an invited address as ACTIVE and attaches its invitations (the account replaces the address)', async () => {
    const prisma = fakePrisma([
      { id: 'm1', invitedEmail: 'guest@example.com', userId: null },
      { id: 'm2', invitedEmail: 'guest@example.com', userId: null },
      { id: 'm3', invitedEmail: 'someone@example.com', userId: null },
    ]);
    const user = await serviceWith(prisma).findOrCreateGoogleUser({ sub: 'g', email: 'Guest@Example.com', displayName: 'Guest' });
    expect(user.status).toBe('ACTIVE');
    expect(user.isAdmin).toBe(false);
    expect(prisma.invitations).toEqual([
      { id: 'm1', invitedEmail: null, userId: user.id },
      { id: 'm2', invitedEmail: null, userId: user.id },
      { id: 'm3', invitedEmail: 'someone@example.com', userId: null },
    ]);
  });

  it('attaches invitations to a new ADMIN_EMAILS account too', async () => {
    const prisma = fakePrisma([{ id: 'm1', invitedEmail: 'admin@example.com', userId: null }]);
    const user = await serviceWith(prisma).findOrCreateGoogleUser({ sub: '1', email: 'admin@example.com', displayName: 'Admin' });
    expect(prisma.invitations[0]).toEqual({ id: 'm1', invitedEmail: null, userId: user.id });
  });

  it('never changes the status of an existing non-admin PENDING account on login', async () => {
    const prisma = fakePrisma([{ id: 'm1', invitedEmail: 'p@example.com', userId: null }]);
    await prisma.appUser.create({ data: { email: 'p@example.com', googleSub: 'gp', status: 'PENDING' } });
    const user = await serviceWith(prisma).findOrCreateGoogleUser({ sub: 'gp', email: 'p@example.com', displayName: 'P' });
    expect(user.status).toBe('PENDING');
  });

  it('never reactivates a BLOCKED account, even an ADMIN_EMAILS one', async () => {
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'admin@example.com', googleSub: 'gb', status: 'BLOCKED' } });
    await expect(serviceWith(prisma).findOrCreateGoogleUser({ sub: 'gb', email: 'admin@example.com', displayName: 'A' })).rejects.toBeInstanceOf(ForbiddenException);
    expect([...prisma.users.values()][0].status).toBe('BLOCKED');

    const linked = fakePrisma();
    await linked.appUser.create({ data: { email: 'admin@example.com', googleSub: null, status: 'BLOCKED' } });
    await expect(serviceWith(linked).findOrCreateGoogleUser({ sub: 'gl', email: 'admin@example.com', displayName: 'A' })).rejects.toBeInstanceOf(ForbiddenException);
    expect([...linked.users.values()][0].status).toBe('BLOCKED');
  });

  it('activates an existing PENDING account whose e-mail is in ADMIN_EMAILS, then claims the orphan cave', async () => {
    const caves = fakeCaves();
    const prisma = fakePrisma();
    const pending = await prisma.appUser.create({ data: { email: 'admin@example.com', googleSub: 'gp', status: 'PENDING' } });
    const user = await serviceWith(prisma, caves).findOrCreateGoogleUser({ sub: 'gp', email: 'admin@example.com', displayName: 'A' });
    expect(user.status).toBe('ACTIVE');
    expect(user.isAdmin).toBe(true);
    expect(caves.claimOrphanCave).toHaveBeenCalledWith(pending.id);
  });

  it('activates a PENDING ADMIN_EMAILS account linked by e-mail (no google_sub yet), then claims the orphan cave', async () => {
    const caves = fakeCaves();
    const prisma = fakePrisma();
    const pending = await prisma.appUser.create({ data: { email: 'admin@example.com', googleSub: null, status: 'PENDING' } });
    const user = await serviceWith(prisma, caves).findOrCreateGoogleUser({ sub: 'gn', email: 'admin@example.com', displayName: 'A' });
    expect(user.id).toBe(pending.id);
    expect(user.status).toBe('ACTIVE');
    expect(caves.claimOrphanCave).toHaveBeenCalledWith(pending.id);
  });

  it('gives an orphan cave to an administrator on login (not to anyone else)', async () => {
    const caves = fakeCaves();
    const prisma = fakePrisma();
    const admin = await serviceWith(prisma, caves).findOrCreateGoogleUser({ sub: '1', email: 'admin@example.com', displayName: 'Admin' });
    expect(caves.claimOrphanCave).toHaveBeenCalledWith(admin.id);

    const other = fakeCaves();
    await serviceWith(fakePrisma(), other).findOrCreateGoogleUser({ sub: '2', email: 'nobody@example.com', displayName: 'N' });
    expect(other.claimOrphanCave).not.toHaveBeenCalled();
  });

  it('gives an orphan cave to an existing administrator promoted from /admin', async () => {
    const caves = fakeCaves();
    const prisma = fakePrisma();
    const promoted = await prisma.appUser.create({ data: { email: 'promoted@example.com', googleSub: 'gp', isAdmin: true } });
    await serviceWith(prisma, caves).findOrCreateGoogleUser({ sub: 'gp', email: 'promoted@example.com', displayName: 'P' });
    expect(caves.claimOrphanCave).toHaveBeenCalledWith(promoted.id);
  });

  it('never gives an orphan cave on a break-glass login', async () => {
    const caves = fakeCaves();
    const prisma = fakePrisma();
    const hash = await argon2.hash('correct horse battery');
    await prisma.appUser.create({ data: { email: 'admin@example.com', isBreakGlass: true, passwordHash: hash, isAdmin: true } });
    expect(await serviceWith(prisma, caves).verifyLocalLogin('admin@example.com', 'correct horse battery')).not.toBeNull();
    expect(caves.claimOrphanCave).not.toHaveBeenCalled();
  });

  it('never gives an orphan cave to a blocked administrator', async () => {
    const caves = fakeCaves();
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'admin@example.com', googleSub: 'gb', status: 'BLOCKED', isAdmin: true } });
    await expect(serviceWith(prisma, caves).findOrCreateGoogleUser({ sub: 'gb', email: 'admin@example.com', displayName: 'A' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(caves.claimOrphanCave).not.toHaveBeenCalled();
  });

  it('creates then reuses a Google user, keyed by sub', async () => {
    const prisma = fakePrisma();
    const service = serviceWith(prisma);
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
    const service = serviceWith(prisma);

    const linked = await service.findOrCreateGoogleUser({ sub: '999', email: 'owner@example.com', displayName: 'Owner' });

    expect(linked.id).toBe(preexisting.id);
    expect(linked.googleSub).toBe('999');
    expect(prisma.users.size).toBe(1);
  });

  it('marks a user admin when its e-mail is in ADMIN_EMAILS, re-derived on every login', async () => {
    const prisma = fakePrisma();
    const service = serviceWith(prisma);
    const user = await service.findOrCreateGoogleUser({ sub: '1', email: 'admin@example.com', displayName: 'Admin' });
    expect(user.isAdmin).toBe(true);
  });

  it('does not mark a user admin when its e-mail is absent from ADMIN_EMAILS', async () => {
    const prisma = fakePrisma();
    const service = serviceWith(prisma);
    const user = await service.findOrCreateGoogleUser({ sub: '2', email: 'nobody@example.com', displayName: 'Nobody' });
    expect(user.isAdmin).toBe(false);
  });

  it('keeps a promotion made from /admin on a later login, even when the e-mail is absent from ADMIN_EMAILS', async () => {
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'promoted@example.com', googleSub: 'g-promoted', isAdmin: true } });
    const service = serviceWith(prisma);

    const user = await service.findOrCreateGoogleUser({ sub: 'g-promoted', email: 'promoted@example.com', displayName: 'Promoted' });

    expect(user.isAdmin).toBe(true);
  });

  it('grants isAdmin for an ADMIN_EMAILS address even when the database still says false (ADMIN_EMAILS is a floor, not a ceiling)', async () => {
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'admin@example.com', googleSub: 'g-admin', isAdmin: false } });
    const service = serviceWith(prisma);

    const user = await service.findOrCreateGoogleUser({ sub: 'g-admin', email: 'admin@example.com', displayName: 'Admin' });

    expect(user.isAdmin).toBe(true);
  });

  it('sets lastLoginAt on a Google sign-in', async () => {
    const prisma = fakePrisma();
    const service = serviceWith(prisma);
    const user = await service.findOrCreateGoogleUser({ sub: '1', email: 'a@example.com', displayName: 'A' });
    expect(user.lastLoginAt).toBeInstanceOf(Date);
  });

  it('refuses a blocked Google account after updating lastLoginAt, without ever handing out a session', async () => {
    const prisma = fakePrisma();
    await prisma.appUser.create({ data: { email: 'blocked@example.com', googleSub: 'g1', status: 'BLOCKED' } });
    const service = serviceWith(prisma);
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
    const service = serviceWith(prisma);
    expect(await service.verifyLocalLogin('bg@example.com', 'wrong')).toBeNull();
    expect((await service.verifyLocalLogin('bg@example.com', 'correct horse battery'))?.email).toBe('bg@example.com');
  });

  it('refuses a blocked local (break-glass) account even with the right password', async () => {
    const prisma = fakePrisma();
    const hash = await argon2.hash('correct horse battery');
    await prisma.appUser.create({ data: { email: 'bg@example.com', isBreakGlass: true, passwordHash: hash, status: 'BLOCKED' } });
    const service = serviceWith(prisma);
    expect(await service.verifyLocalLogin('bg@example.com', 'correct horse battery')).toBeNull();
  });
});
