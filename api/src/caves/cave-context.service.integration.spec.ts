import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';
import { CaveContextService } from './cave-context.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('CaveContextService (cave courante)', () => {
  const prisma = new PrismaClient();
  const service = new CaveContextService(prisma as any);
  const userIds: string[] = [];
  const caveIds: string[] = [];

  async function user() {
    const u = await prisma.appUser.create({ data: { email: `ctx-${randomUUID()}@example.test` } });
    userIds.push(u.id);
    return u;
  }
  async function cave(name: string, owner?: { id: string }) {
    const c = await createTestCave(prisma, { name, owner });
    caveIds.push(c.id);
    return c;
  }
  async function viewer(caveId: string, userId: string, createdAt?: Date) {
    await prisma.caveMember.create({ data: { caveId, userId, role: 'VIEWER', ...(createdAt ? { createdAt } : {}) } });
  }

  afterAll(async () => {
    await deleteTestCaves(prisma, caveIds);
    await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('liste les caves du compte, la sienne d’abord puis par nom, sans les invitations en attente', async () => {
    const me = await user();
    const other = await user();
    const mine = await cave('Zèbre', me);
    const b = await cave('Bourgogne', other);
    const a = await cave('Alsace', other);
    const invitedOnly = await cave('Invitation seule', other);
    await viewer(b.id, me.id);
    await viewer(a.id, me.id);
    await prisma.caveMember.create({ data: { caveId: invitedOnly.id, invitedEmail: me.email, role: 'VIEWER' } });

    expect(await service.listForUser(me.id)).toEqual([
      { id: mine.id, name: 'Zèbre', role: 'OWNER' },
      { id: a.id, name: 'Alsace', role: 'VIEWER' },
      { id: b.id, name: 'Bourgogne', role: 'VIEWER' },
    ]);
  });

  it('garde la cave de la session si elle est encore accessible', async () => {
    const me = await user();
    const other = await user();
    await cave('À moi', me);
    const shared = await cave('Partagée', other);
    await viewer(shared.id, me.id);
    expect(await service.resolveCurrent(me.id, shared.id)).toEqual({ caveId: shared.id, role: 'VIEWER' });
  });

  it('sinon sa cave OWNER', async () => {
    const me = await user();
    const other = await user();
    const mine = await cave('À moi', me);
    const foreign = await cave('Étrangère', other);
    expect(await service.resolveCurrent(me.id, foreign.id)).toEqual({ caveId: mine.id, role: 'OWNER' });
    expect(await service.resolveCurrent(me.id, null)).toEqual({ caveId: mine.id, role: 'OWNER' });
    expect(await service.resolveCurrent(me.id)).toEqual({ caveId: mine.id, role: 'OWNER' });
  });

  it('sinon la plus ancienne invitation (date d’ajout du membre)', async () => {
    const me = await user();
    const other = await user();
    const first = await cave('Récente', other);
    const second = await cave('Ancienne', other);
    await viewer(first.id, me.id, new Date('2026-02-01T00:00:00Z'));
    await viewer(second.id, me.id, new Date('2026-01-01T00:00:00Z'));
    expect(await service.resolveCurrent(me.id, undefined)).toEqual({ caveId: second.id, role: 'VIEWER' });
  });

  it('sinon aucune cave', async () => {
    const me = await user();
    expect(await service.resolveCurrent(me.id, randomUUID())).toBeNull();
    expect(await service.listForUser(me.id)).toEqual([]);
  });

  it('findAccess rend le rôle du compte dans une cave, null sans accès', async () => {
    const me = await user();
    const other = await user();
    const mine = await cave('À moi', me);
    const foreign = await cave('Étrangère', other);
    expect(await service.findAccess(me.id, mine.id)).toEqual({ caveId: mine.id, role: 'OWNER' });
    expect(await service.findAccess(me.id, foreign.id)).toBeNull();
    expect(await service.findAccess(me.id, 'pas-une-cave')).toBeNull();
  });
});
