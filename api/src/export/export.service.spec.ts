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
    appellation: { findMany: async () => [{ canonicalName: 'Bandol', region: 'Provence', allowedColors: ['ROUGE', 'ROSE'], guardMinYears: 5, guardMaxYears: 20 }] },
    exportLog: { create: jest.fn(async ({ data }: any) => data) },
  };
}

describe('ExportService.buildWorkbook', () => {
  it('writes three sheets and only wines in stock on Stock', async () => {
    const prisma = fakePrisma();
    const { buffer, rowCount } = await new ExportService(prisma as any, noRules as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exceljs's index.d.ts shadows the global Buffer
    // with a local `interface Buffer extends ArrayBuffer {}` stub inside .load()'s signature, so a real Node Buffer
    // (from Buffer.from()) fails structural assignability against it. Cast is test-only; production code is unaffected.
    await wb.xlsx.load(buffer as any);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Stock', 'Mouvements', 'Référence']);
    const stock = wb.getWorksheet('Stock')!;
    expect(stock.rowCount).toBe(2); // header + Tempier
    expect(stock.getRow(2).getCell(1).value).toBe('Domaine Tempier');
    expect(stock.getRow(2).getCell(11).value).toBe(12);
    expect(stock.getRow(2).getCell(13).value).toBe(576); // 12 × 48 €
    expect(rowCount).toBe(1);
    expect(wb.getWorksheet('Mouvements')!.rowCount).toBe(4);
    expect(prisma.exportLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', rowCount: 1 }) }));
    expect(stock.autoFilter).toBeTruthy();
    expect(wb.getWorksheet('Mouvements')!.autoFilter).toBeTruthy();
    expect(wb.getWorksheet('Référence')!.autoFilter).toBeTruthy();
  });

  it('filters Stock by colour', async () => {
    const prisma = fakePrisma();
    const { rowCount } = await new ExportService(prisma as any, noRules as any).buildWorkbook({ color: 'BLANC' }, 'u1');
    expect(rowCount).toBe(0);
  });

  it('ajoute l’apogée estimée et sa confiance après le millésime', async () => {
    const { buffer } = await new ExportService(fakePrisma() as any, noRules as any).buildWorkbook({}, 'u1');
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
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook({}, 'u1');
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
    const { buffer } = await new ExportService(prisma as any, noRules as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voir le premier test
    await wb.xlsx.load(buffer as any);
    expect([6, 7, 8].map((c) => wb.getWorksheet('Stock')!.getRow(2).getCell(c).value)).toEqual([null, null, null]);
  });
});
