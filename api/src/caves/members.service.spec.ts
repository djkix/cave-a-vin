import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MembersService } from './members.service';

const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

/** Faux Prisma minimal : la transaction rejoue le même client. */
function fakePrisma(opts: { user?: any; existing?: any; createError?: Error; member?: any } = {}) {
  const prisma: any = {
    appUser: {
      findFirst: jest.fn(async () => opts.user ?? null),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    caveMember: {
      findFirst: jest.fn(async () => opts.member ?? opts.existing ?? null),
      create: jest.fn(async ({ data }: any) => {
        if (opts.createError) throw opts.createError;
        return { id: 'm1', createdAt: new Date(), ...data };
      }),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return prisma;
}

describe('MembersService.add', () => {
  it('course perdue sur l’unicité (P2002) : 409 « Cette adresse est déjà membre »', async () => {
    const service = new MembersService(fakePrisma({ createError: p2002() }));
    const e = await service.add('c1', 'x@example.test').catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.message).toBe('Cette adresse est déjà membre');
  });

  it('autre erreur : relancée telle quelle', async () => {
    const boom = new Error('base injoignable');
    await expect(new MembersService(fakePrisma({ createError: boom })).add('c1', 'x@example.test')).rejects.toBe(boom);
  });

  it('déjà membre ou invité : 409 sans rien créer', async () => {
    const prisma = fakePrisma({ existing: { id: 'm0' } });
    await expect(new MembersService(prisma).add('c1', 'x@example.test')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.caveMember.create).not.toHaveBeenCalled();
  });

  it('compte en attente : passé ACTIVE par une mise à jour conditionnelle (PENDING seulement)', async () => {
    const prisma = fakePrisma({ user: { id: 'u1', email: 'x@example.test', displayName: 'X', status: 'PENDING' } });
    const view = await new MembersService(prisma).add('c1', 'x@example.test');
    expect(prisma.appUser.updateMany).toHaveBeenCalledWith({ where: { id: 'u1', status: 'PENDING' }, data: { status: 'ACTIVE' } });
    expect(prisma.caveMember.create).toHaveBeenCalledWith({ data: { caveId: 'c1', userId: 'u1', role: 'VIEWER' } });
    expect(view).toEqual({ id: 'm1', email: 'x@example.test', displayName: 'X', role: 'VIEWER', pending: false });
  });

  it('compte bloqué : rattaché, statut inchangé', async () => {
    const prisma = fakePrisma({ user: { id: 'u1', email: 'x@example.test', displayName: null, status: 'BLOCKED' } });
    await new MembersService(prisma).add('c1', 'x@example.test');
    expect(prisma.appUser.updateMany).not.toHaveBeenCalled();
    expect(prisma.caveMember.create).toHaveBeenCalled();
  });
});

describe('MembersService.remove', () => {
  it('ligne OWNER : 400 « Le propriétaire ne peut pas être retiré »', async () => {
    const prisma = fakePrisma({ member: { id: 'm1', role: 'OWNER' } });
    const e = await new MembersService(prisma).remove('c1', 'm1').catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Le propriétaire ne peut pas être retiré');
    expect(prisma.caveMember.deleteMany).not.toHaveBeenCalled();
  });

  it('cherche le membre dans la cave courante seulement : sinon 404', async () => {
    const prisma = fakePrisma({ member: null });
    await expect(new MembersService(prisma).remove('c1', 'm9')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.caveMember.findFirst).toHaveBeenCalledWith({ where: { id: 'm9', caveId: 'c1' }, select: { id: true, role: true } });
  });

  it('retire un VIEWER par une suppression bornée à la cave et au rôle', async () => {
    const prisma = fakePrisma({ member: { id: 'm1', role: 'VIEWER' } });
    await new MembersService(prisma).remove('c1', 'm1');
    expect(prisma.caveMember.deleteMany).toHaveBeenCalledWith({ where: { id: 'm1', caveId: 'c1', role: 'VIEWER' } });
  });
});
