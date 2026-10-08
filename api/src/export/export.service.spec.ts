import ExcelJS from 'exceljs';
import { compileApogeeRules } from '../apogee/apogee';
import { ExportService } from './export.service';

const noRules = { load: async () => compileApogeeRules({ guardOverrides: [], vintageQualities: [] }) };

function fakePrisma() {
  const wines = [
    {
      id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null,
      appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 },
    },
    {
      id: 'w2', producer: 'Leflaive', cuvee: null, appellationRaw: 'Puligny-Montrachet', vintage: 2020, color: 'BLANC', formatCl: 75,
      appellationId: null, apogeeMin: null, apogeeMax: null, apogeeSource: null,
      appellation: { region: 'Bourgogne', guardMinYears: null, guardMaxYears: null },
    },
  ];
  const movements = [
    { id: 'm1', wineId: 'w1', delta: 12, type: 'IN', occurredAt: new Date('2026-09-01'), priceUnitCents: 4800, note: null, wine: wines[0] },
    { id: 'm2', wineId: 'w2', delta: 6, type: 'IN', occurredAt: new Date('2026-09-02'), priceUnitCents: null, note: null, wine: wines[1] },
    { id: 'm3', wineId: 'w2', delta: -6, type: 'ADJUST', occurredAt: new Date('2026-09-03'), priceUnitCents: null, note: 'Annulation', wine: wines[1] },
  ];
  return {
    $queryRaw: async () => [{ wine_id: 'w1', quantity: 12 }, { wine_id: 'w2', quantity: 0 }],
    wine: { findMany: async () => wines },
    movement: { findMany: async () => [...movements].reverse() },
    priceQuote: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    appellation: { findMany: async () => [{ canonicalName: 'Bandol', region: 'Provence', allowedColors: ['ROUGE', 'ROSE'], guardMinYears: 5, guardMaxYears: 20 }] },
    exportLog: { create: jest.fn(async ({ data }: any) => data) },
  };
}

describe('ExportService.buildWorkbook', () => {
  it('writes three sheets and only wines in stock on Stock', async () => {
    const prisma = fakePrisma();
    const wineFind = jest.spyOn(prisma.wine, 'findMany');
    const movementFind = jest.spyOn(prisma.movement, 'findMany');
    const { buffer, rowCount } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exceljs's index.d.ts shadows the global Buffer
    // with a local `interface Buffer extends ArrayBuffer {}` stub inside .load()'s signature, so a real Node Buffer
    // (from Buffer.from()) fails structural assignability against it. Cast is test-only; production code is unaffected.
    await wb.xlsx.load(buffer as any);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Stock', 'Mouvements', 'Référence']);
    const stock = wb.getWorksheet('Stock')!;
    expect(stock.rowCount).toBe(2); // header + Tempier
    expect(stock.getRow(2).getCell(1).value).toBe('Domaine Tempier');
    expect(stock.getRow(2).getCell(12).value).toBe(12);
    expect(stock.getRow(2).getCell(14).value).toBe(576); // 12 × 48 €
    expect(rowCount).toBe(1);
    expect(wb.getWorksheet('Mouvements')!.rowCount).toBe(4);
    expect(prisma.exportLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', rowCount: 1, caveId: 'c1' }) }));
    expect(wineFind).toHaveBeenCalledWith(expect.objectContaining({ where: { caveId: 'c1' } }));
    expect(movementFind).toHaveBeenCalledWith(expect.objectContaining({ where: { wine: { caveId: 'c1' } } }));
    expect(stock.autoFilter).toBeTruthy();
    expect(wb.getWorksheet('Mouvements')!.autoFilter).toBeTruthy();
    expect(wb.getWorksheet('Référence')!.autoFilter).toBeTruthy();
  });

  it('filters Stock by colour', async () => {
    const prisma = fakePrisma();
    const { rowCount } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', { color: 'BLANC' }, 'u1');
    expect(rowCount).toBe(0);
  });

  it('ajoute l’apogée estimée et sa confiance après le millésime', async () => {
    const { buffer } = await new ExportService(fakePrisma() as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const stock = wb.getWorksheet('Stock')!;
    expect([6, 7, 8].map((c) => stock.getRow(1).getCell(c).value)).toEqual(['Apogée min', 'Apogée max', 'Confiance']);
    // Bandol 2019, garde 5-20, millésime non qualifié.
    expect([6, 7, 8].map((c) => stock.getRow(2).getCell(c).value)).toEqual([2024, 2039, 'Faible']);
  });

  it('met en évidence une ligne dont l’apogée est passée', async () => {
    const prisma = fakePrisma();
    const old = { id: 'w9', producer: 'Vieux Domaine', cuvee: null, appellationRaw: 'Bandol', vintage: 2000, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 } };
    prisma.wine.findMany = async () => [old] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w9', quantity: 1 }];
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const row = wb.getWorksheet('Stock')!.getRow(2);
    expect(row.getCell(7).value).toBe(2020);
    expect((row.getCell(1).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFFCE4D6');
  });

  it('laisse l’apogée vide pour un vin sans estimation', async () => {
    const prisma = fakePrisma();
    const nv = { id: 'w8', producer: 'Champagne Essai', cuvee: null, appellationRaw: 'Champagne', vintage: null, color: 'PETILLANT', formatCl: 75,
      appellationId: 'a-ch', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Champagne', guardMinYears: 1, guardMaxYears: 4 } };
    prisma.wine.findMany = async () => [nv] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w8', quantity: 3 }];
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    expect([6, 7, 8].map((c) => wb.getWorksheet('Stock')!.getRow(2).getCell(c).value)).toEqual([null, null, null]);
  });

  it('ignore le prix d’une entrée annulée, comme les statistiques', async () => {
    const prisma = fakePrisma();
    const wine = {
      id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null,
      appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 },
    };
    prisma.wine.findMany = async () => [wine] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w1', quantity: 12 }];
    const movements = [
      { id: 'm1', wineId: 'w1', delta: 12, type: 'IN', occurredAt: new Date('2026-09-01'), priceUnitCents: 4800, note: null, reversesId: null, wine },
      { id: 'm2', wineId: 'w1', delta: 6, type: 'IN', occurredAt: new Date('2026-09-10'), priceUnitCents: 9000, note: null, reversesId: null, wine },
      { id: 'm3', wineId: 'w1', delta: -6, type: 'ADJUST', occurredAt: new Date('2026-09-11'), priceUnitCents: null, note: 'Annulation', reversesId: 'm2', wine },
    ];
    prisma.movement.findMany = async () => [...movements].reverse();
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const stock = wb.getWorksheet('Stock')!;
    expect(stock.getRow(2).getCell(13).value).toBe(48);
    expect(stock.getRow(2).getCell(14).value).toBe(576); // 12 × 48 €
  });

  it('« à boire en priorité » ne garde que les fins d’apogée jusqu’à l’an prochain, la plus proche en premier', async () => {
    // Seule la date est simulée : exceljs a besoin des vrais minuteurs.
    jest.useFakeTimers({ now: new Date('2026-06-01'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    try {
      const prisma = fakePrisma();
      const bandol = (id: string, producer: string, vintage: number) => ({ id, producer, cuvee: null, appellationRaw: 'Bandol', vintage, color: 'ROUGE', formatCl: 75,
        appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 } });
      // Fins d'apogée : 2027, 2028, 2020.
      prisma.wine.findMany = async () => [bandol('w7', 'Sept', 2007), bandol('w8', 'Huit', 2008), bandol('w0', 'Zéro', 2000)] as any;
      prisma.$queryRaw = async () => [{ wine_id: 'w7', quantity: 1 }, { wine_id: 'w8', quantity: 1 }, { wine_id: 'w0', quantity: 1 }];
      const { buffer, rowCount } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', { drinkSoon: true }, 'u1');
      const wb = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
      await wb.xlsx.load(buffer as any);
      const stock = wb.getWorksheet('Stock')!;
      expect(rowCount).toBe(2);
      expect([2, 3].map((r) => stock.getRow(r).getCell(1).value)).toEqual(['Zéro', 'Sept']);
      expect(prisma.exportLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ filter: { drinkSoon: true } }) }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('ajoute la note et les accords à la feuille Stock', async () => {
    const prisma = fakePrisma();
    const rated = {
      id: 'w5', producer: 'Domaine Noté', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, rating: 16.5,
      appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 },
      pairing: { status: 'DONE', dishes: ['agneau de sept heures', 'daube provençale'] },
    };
    prisma.wine.findMany = async () => [rated] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w5', quantity: 2 }];
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const stock = wb.getWorksheet('Stock')!;
    expect([9, 15].map((c) => stock.getRow(1).getCell(c).value)).toEqual(['Note /20', 'Accords']);
    expect([9, 15].map((c) => stock.getRow(2).getCell(c).value)).toEqual([16.5, 'agneau de sept heures ; daube provençale']);
  });

  it('ajoute la colonne « Emplacements » : « Cave 2 / B / 3 × 4 ; Sans emplacement × 2 »', async () => {
    const prisma = fakePrisma();
    const wine = {
      id: 'w1', producer: 'Domaine Tempier', cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 },
    };
    const b3 = { id: 'l1', zoneId: 'z1', zone: { name: 'Cave 2' }, casier: 'B', position: '3' };
    prisma.wine.findMany = async () => [wine] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w1', quantity: 6 }];
    const at = (id: string, delta: number, type: string, location: typeof b3 | null) =>
      ({ id, wineId: 'w1', delta, type, occurredAt: new Date('2026-09-01'), priceUnitCents: null, note: null, reversesId: null, wine, locationId: location?.id ?? null, location });
    prisma.movement.findMany = async () => [at('m1', 6, 'IN', null), at('m2', -4, 'MOVE', null), at('m3', 4, 'MOVE', b3)].reverse() as any;
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const stock = wb.getWorksheet('Stock')!;
    expect(stock.getRow(1).getCell(16).value).toBe('Emplacements');
    expect(stock.getRow(2).getCell(16).value).toBe('Cave 2 / B / 3 × 4 ; Sans emplacement × 2');
  });

  it('ajoute la cote iDealwine courante, sa date et la valeur à la cote ; vides sans cote', async () => {
    const prisma = fakePrisma();
    const bandol = (id: string, producer: string) => ({ id, producer, cuvee: null, appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75,
      appellationId: 'a-bandol', apogeeMin: null, apogeeMax: null, apogeeSource: null, appellation: { region: 'Provence', guardMinYears: 5, guardMaxYears: 20 } });
    prisma.wine.findMany = async () => [bandol('w1', 'A Coté'), bandol('w2', 'B Sans cote')] as any;
    prisma.$queryRaw = async () => [{ wine_id: 'w1', quantity: 6 }, { wine_id: 'w2', quantity: 2 }];
    prisma.priceQuote.findMany.mockImplementation(async () => [
      { wineId: 'w1', coteCents: 9000, quotedOn: new Date('2025-01-01T00:00:00Z'), createdAt: new Date('2025-01-02T00:00:00Z') },
      { wineId: 'w1', coteCents: 8550, quotedOn: new Date('2026-03-03T00:00:00Z'), createdAt: new Date('2026-03-04T00:00:00Z') },
    ]);
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook('c1', {}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    const stock = wb.getWorksheet('Stock')!;
    expect([17, 18, 19].map((c) => stock.getRow(1).getCell(c).value)).toEqual(['Cote iDealwine (€)', 'Date de la cote', 'Valeur à la cote (€)']);
    const [cote, date, value] = [17, 18, 19].map((c) => stock.getRow(2).getCell(c));
    expect(cote.value).toBe(85.5);
    expect(date.value).toEqual(new Date('2026-03-03T00:00:00Z'));
    expect(date.numFmt).toBe('dd/mm/yyyy');
    expect(value.value).toBe(513); // 6 × 85,50 €
    expect([17, 18, 19].map((c) => stock.getRow(3).getCell(c).value)).toEqual([null, null, null]);
    expect(stock.autoFilter).toBe('A1:S1');
    expect(prisma.priceQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { wine: { caveId: 'c1' } } }));
  });
});
