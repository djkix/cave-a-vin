import { PrismaClient } from '@prisma/client';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppellationsService } from '../appellations/appellations.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('règles d’apogée (base réelle)', () => {
  const prisma = new PrismaClient();
  const name = `AOC essai apogée ${Date.now()}`;
  let appellationId: string;

  beforeAll(async () => {
    const a = await prisma.appellation.create({ data: { canonicalName: name, region: 'Essai', allowedColors: ['ROUGE', 'ROSE'], guardMinYears: 2, guardMaxYears: 6 } });
    appellationId = a.id;
  });

  afterAll(async () => {
    await prisma.guardOverride.deleteMany({ where: { appellationId } });
    await prisma.appellation.delete({ where: { id: appellationId } });
    await prisma.vintageQuality.deleteMany({ where: { region: 'Essai' } });
    await prisma.$disconnect();
  });

  it('garde un ajustement de garde quand le référentiel est rechargé au démarrage', async () => {
    await prisma.guardOverride.create({ data: { appellationId, color: null, guardMinYears: 5, guardMaxYears: 15 } });
    // Rechargement tel que le fait AppellationsModule.onModuleInit, avec la garde du fichier.
    const dir = mkdtempSync(join(tmpdir(), 'ref-'));
    const file = join(dir, 'appellations.json');
    writeFileSync(file, JSON.stringify([{ canonicalName: name, region: 'Essai', allowedColors: ['ROUGE', 'ROSE'], guardMinYears: 2, guardMaxYears: 6 }]));
    await new AppellationsService(prisma as never).seedFromFile(file);
    const overrides = await prisma.guardOverride.findMany({ where: { appellationId } });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ guardMinYears: 5, guardMaxYears: 15, color: null });
  });

  it('refuse un second ajustement toutes couleurs pour la même appellation', async () => {
    await expect(prisma.guardOverride.create({ data: { appellationId, color: null, guardMinYears: 1, guardMaxYears: 2 } })).rejects.toThrow();
  });

  it('accepte un ajustement par couleur à côté de l’ajustement toutes couleurs, mais pas deux pour la même couleur', async () => {
    await prisma.guardOverride.create({ data: { appellationId, color: 'ROSE', guardMinYears: 1, guardMaxYears: 3 } });
    await expect(prisma.guardOverride.create({ data: { appellationId, color: 'ROSE', guardMinYears: 2, guardMaxYears: 4 } })).rejects.toThrow();
  });

  it('qualifie un millésime par région et par année, une seule fois', async () => {
    await prisma.vintageQuality.create({ data: { region: 'Essai', year: 2016, quality: 'GRAND' } });
    await expect(prisma.vintageQuality.create({ data: { region: 'Essai', year: 2016, quality: 'FAIBLE' } })).rejects.toThrow();
  });
});
