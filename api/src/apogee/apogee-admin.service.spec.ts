import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApogeeAdminService } from './apogee-admin.service';

function fakePrisma() {
  const qualities = new Map<string, any>();
  const overrides: any[] = [];
  const appellations = [
    { id: 'a1', canonicalName: 'Châteauneuf-du-Pape', region: 'Rhône', guardMinYears: 8, guardMaxYears: 20 },
    { id: 'a2', canonicalName: 'Bandol', region: 'Provence', guardMinYears: 5, guardMaxYears: 20 },
    { id: 'a3', canonicalName: 'Faugères', region: 'Languedoc-Roussillon', guardMinYears: 3, guardMaxYears: 8 },
  ];
  return {
    qualities, overrides,
    appellation: {
      findMany: jest.fn(async (args: any) => {
        if (args?.distinct) return [...new Set(appellations.map((a) => a.region))].sort().map((region) => ({ region }));
        return appellations.map((a) => ({ ...a, guardOverrides: overrides.filter((o) => o.appellationId === a.id) }));
      }),
      findUnique: jest.fn(async ({ where }: any) => appellations.find((a) => a.id === where.id) ?? null),
    },
    vintageQuality: {
      findMany: jest.fn(async () => [...qualities.values()]),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.region_year.region}|${where.region_year.year}`;
        const row = { ...(qualities.get(key) ?? create), ...update };
        qualities.set(key, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const deleted = qualities.delete(`${where.region}|${where.year}`);
        return { count: deleted ? 1 : 0 };
      }),
    },
    guardOverride: {
      findFirst: jest.fn(async ({ where }: any) => overrides.find((o) => o.appellationId === where.appellationId && o.color === where.color) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `o${overrides.length + 1}`, ...data };
        overrides.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(overrides.find((o) => o.id === where.id), data)),
      delete: jest.fn(async ({ where }: any) => {
        const i = overrides.findIndex((o) => o.id === where.id);
        if (i < 0) throw new Prisma.PrismaClientKnownRequestError('absent', { code: 'P2025', clientVersion: 'test' });
        return overrides.splice(i, 1)[0];
      }),
    },
  };
}

describe('ApogeeAdminService — millésimes', () => {
  it('liste les régions du référentiel et les millésimes qualifiés', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setVintage({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    expect(await s.listVintages()).toEqual({
      regions: ['Languedoc-Roussillon', 'Provence', 'Rhône'],
      qualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }],
    });
  });

  it('remplace la qualité d’un millésime déjà qualifié', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setVintage({ region: 'Rhône', year: 2016, quality: 'GRAND' });
    await s.setVintage({ region: 'Rhône', year: 2016, quality: 'FAIBLE' });
    expect((await s.listVintages()).qualities).toEqual([{ region: 'Rhône', year: 2016, quality: 'FAIBLE' }]);
  });

  it('refuse une région absente du référentiel', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    await expect(s.setVintage({ region: 'Atlantide', year: 2016, quality: 'GRAND' })).rejects.toThrow(new BadRequestException('Région inconnue du référentiel'));
  });

  it('remet un millésime à « non qualifié », y compris pour une région à tiret', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setVintage({ region: 'Languedoc-Roussillon', year: 2016, quality: 'GRAND' });
    await s.removeVintage('Languedoc-Roussillon', 2016);
    expect((await s.listVintages()).qualities).toEqual([]);
  });
});

describe('ApogeeAdminService — gardes', () => {
  it('cherche une appellation sans accents et montre garde et ajustements', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    await s.setGuard({ appellationId: 'a1', color: null, min: 10, max: 25 });
    expect(await s.searchGuards('chateauneuf')).toEqual([
      { id: 'a1', canonicalName: 'Châteauneuf-du-Pape', region: 'Rhône', guardMinYears: 8, guardMaxYears: 20, overrides: [{ id: 'o1', color: null, min: 10, max: 25 }] },
    ]);
  });

  it('crée puis remplace l’ajustement d’une même appellation et couleur', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    const first = await s.setGuard({ appellationId: 'a2', color: 'ROSE', min: 1, max: 3 });
    const second = await s.setGuard({ appellationId: 'a2', color: 'ROSE', min: 2, max: 4 });
    expect(second.id).toBe(first.id);
    expect(p.overrides).toHaveLength(1);
    expect(second).toEqual({ id: first.id, color: 'ROSE', min: 2, max: 4 });
  });

  it('distingue l’ajustement toutes couleurs de l’ajustement par couleur', async () => {
    const p = fakePrisma();
    const s = new ApogeeAdminService(p as any);
    await s.setGuard({ appellationId: 'a2', color: null, min: 6, max: 18 });
    await s.setGuard({ appellationId: 'a2', color: 'ROSE', min: 1, max: 3 });
    expect(p.overrides).toHaveLength(2);
  });

  it('refuse une appellation inconnue', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    await expect(s.setGuard({ appellationId: 'zz', color: null, min: 1, max: 2 })).rejects.toThrow(new NotFoundException('Appellation introuvable'));
  });

  it('retire un ajustement, et répond 404 s’il n’existe pas', async () => {
    const s = new ApogeeAdminService(fakePrisma() as any);
    const o = await s.setGuard({ appellationId: 'a1', color: null, min: 10, max: 25 });
    await s.removeGuard(o.id);
    await expect(s.removeGuard(o.id)).rejects.toThrow(new NotFoundException('Ajustement introuvable'));
  });
});
