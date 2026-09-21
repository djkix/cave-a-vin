import ExcelJS from 'exceljs';
import { ExportService } from './export.service';

function fakePrisma() {
  const wines = [
    { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, appellation: { region: 'Provence' } },
    { id: 'w2', producer: 'Leflaive', cuvee: null, appellationRaw: 'Puligny-Montrachet', vintage: 2020, color: 'BLANC', formatCl: 75, appellation: { region: 'Bourgogne' } },
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
    const { buffer, rowCount } = await new ExportService(prisma as any).buildWorkbook({}, 'u1');
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exceljs's index.d.ts shadows the global Buffer
    // with a local `interface Buffer extends ArrayBuffer {}` stub inside .load()'s signature, so a real Node Buffer
    // (from Buffer.from()) fails structural assignability against it. Cast is test-only; production code is unaffected.
    await wb.xlsx.load(buffer as any);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Stock', 'Mouvements', 'Référence']);
    const stock = wb.getWorksheet('Stock')!;
    expect(stock.rowCount).toBe(2); // header + Tempier
    expect(stock.getRow(2).getCell(1).value).toBe('Domaine Tempier');
    expect(stock.getRow(2).getCell(8).value).toBe(12);
    expect(stock.getRow(2).getCell(10).value).toBe(576); // 12 × 48 €
    expect(rowCount).toBe(1);
    expect(wb.getWorksheet('Mouvements')!.rowCount).toBe(4);
    expect(prisma.exportLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', rowCount: 1 }) }));
  });

  it('filters Stock by colour', async () => {
    const prisma = fakePrisma();
    const { rowCount } = await new ExportService(prisma as any).buildWorkbook({ color: 'BLANC' }, 'u1');
    expect(rowCount).toBe(0);
  });
});
