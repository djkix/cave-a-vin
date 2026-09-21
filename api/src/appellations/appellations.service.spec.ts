import { PrismaClient } from '@prisma/client';
import { AppellationsService } from './appellations.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('AppellationsService.resolve', () => {
  const prisma = new PrismaClient();
  const service = new AppellationsService(prisma as any);

  beforeAll(async () => {
    await prisma.appellation.upsert({
      where: { canonicalName: 'Châteauneuf-du-Pape' },
      update: {},
      create: { canonicalName: 'Châteauneuf-du-Pape', region: 'Rhône', allowedColors: ['ROUGE', 'BLANC'] },
    });
  });
  afterAll(() => prisma.$disconnect());

  it('aligns a close spelling silently (>= 0.8)', async () => {
    const m = await service.resolve('Chateauneuf du Pape');
    expect(m.kind).toBe('exact');
    if (m.kind !== 'none') expect(m.canonicalName).toBe('Châteauneuf-du-Pape');
  });

  it('flags a loose match (0.5–0.8) as fuzzy', async () => {
    const m = await service.resolve('Chateauneuf');
    expect(m.kind).toBe('fuzzy');
  });

  it('keeps unknown text raw (< 0.5)', async () => {
    const m = await service.resolve('Vin de table du garage');
    expect(m).toEqual({ kind: 'none', raw: 'Vin de table du garage' });
  });
});
