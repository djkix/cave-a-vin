import { Injectable } from '@nestjs/common';
import { Prisma, WineColor } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';

export interface ExportFilter {
  color?: WineColor;
  region?: string;
}

const COLOR_LABEL: Record<WineColor, string> = { ROUGE: 'Rouge', BLANC: 'Blanc', ROSE: 'Rosé', PETILLANT: 'Pétillant' };

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async buildWorkbook(filter: ExportFilter, userId: string): Promise<{ buffer: Buffer; rowCount: number }> {
    const [stockRows, wines, movements, appellations] = await Promise.all([
      this.prisma.$queryRaw<{ wine_id: string; quantity: number }[]>`SELECT wine_id, quantity FROM stock_courant`,
      this.prisma.wine.findMany({ include: { appellation: true }, orderBy: [{ producer: 'asc' }, { vintage: 'asc' }] }),
      this.prisma.movement.findMany({ include: { wine: true }, orderBy: { occurredAt: 'desc' } }),
      this.prisma.appellation.findMany({ orderBy: { canonicalName: 'asc' } }),
    ]);
    const stockByWine = new Map(stockRows.map((r) => [r.wine_id, Number(r.quantity)]));
    const lastPrice = new Map<string, number>();
    for (const m of [...movements].reverse()) if (m.priceUnitCents != null) lastPrice.set(m.wineId, m.priceUnitCents);

    const inStock = wines.filter((w) => {
      const q = stockByWine.get(w.id) ?? 0;
      if (q <= 0) return false;
      if (filter.color && w.color !== filter.color) return false;
      if (filter.region && (w.appellation?.region ?? '').toLowerCase() !== filter.region.toLowerCase()) return false;
      return true;
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Cave & Terroir';
    wb.created = new Date();

    const stock = wb.addWorksheet('Stock', { views: [{ state: 'frozen', ySplit: 1 }] });
    stock.columns = [
      { header: 'Producteur', key: 'producer', width: 28 },
      { header: 'Cuvée', key: 'cuvee', width: 22 },
      { header: 'Appellation', key: 'appellation', width: 26 },
      { header: 'Région', key: 'region', width: 14 },
      { header: 'Millésime', key: 'vintage', width: 10 },
      { header: 'Couleur', key: 'color', width: 10 },
      { header: 'Format (cl)', key: 'formatCl', width: 10 },
      { header: 'Quantité', key: 'quantity', width: 10 },
      { header: "Prix d'achat unitaire (€)", key: 'price', width: 20 },
      { header: "Valeur d'achat (€)", key: 'value', width: 16 },
    ];
    for (const w of inStock) {
      const q = stockByWine.get(w.id) ?? 0;
      const price = lastPrice.has(w.id) ? lastPrice.get(w.id)! / 100 : null;
      stock.addRow({
        producer: w.producer, cuvee: w.cuvee ?? '', appellation: w.appellationRaw, region: w.appellation?.region ?? '',
        vintage: w.vintage ?? 'NV', color: COLOR_LABEL[w.color], formatCl: w.formatCl, quantity: q,
        price, value: price == null ? null : Math.round(price * q * 100) / 100,
      });
    }
    stock.autoFilter = { from: 'A1', to: 'J1' };
    stock.getRow(1).font = { bold: true };

    const mv = wb.addWorksheet('Mouvements', { views: [{ state: 'frozen', ySplit: 1 }] });
    mv.columns = [
      { header: 'Date', key: 'date', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
      { header: 'Type', key: 'type', width: 8 },
      { header: 'Delta', key: 'delta', width: 8 },
      { header: 'Producteur', key: 'producer', width: 28 },
      { header: 'Cuvée', key: 'cuvee', width: 22 },
      { header: 'Appellation', key: 'appellation', width: 26 },
      { header: 'Millésime', key: 'vintage', width: 10 },
      { header: 'Prix unitaire (€)', key: 'price', width: 16 },
      { header: 'Note', key: 'note', width: 40 },
    ];
    for (const m of movements) {
      mv.addRow({
        date: m.occurredAt, type: m.type, delta: m.delta, producer: m.wine.producer, cuvee: m.wine.cuvee ?? '',
        appellation: m.wine.appellationRaw, vintage: m.wine.vintage ?? 'NV',
        price: m.priceUnitCents == null ? null : m.priceUnitCents / 100, note: m.note ?? '',
      });
    }
    mv.autoFilter = { from: 'A1', to: 'I1' };
    mv.getRow(1).font = { bold: true };

    const ref = wb.addWorksheet('Référence', { views: [{ state: 'frozen', ySplit: 1 }] });
    ref.columns = [
      { header: 'Appellation', key: 'name', width: 30 },
      { header: 'Région', key: 'region', width: 16 },
      { header: 'Couleurs', key: 'colors', width: 22 },
      { header: 'Garde min (ans)', key: 'gmin', width: 14 },
      { header: 'Garde max (ans)', key: 'gmax', width: 14 },
    ];
    for (const a of appellations) {
      ref.addRow({ name: a.canonicalName, region: a.region ?? '', colors: a.allowedColors.map((c) => COLOR_LABEL[c]).join(', '), gmin: a.guardMinYears, gmax: a.guardMaxYears });
    }
    ref.getRow(1).font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    await this.prisma.exportLog.create({ data: { userId, filter: filter as Prisma.InputJsonValue, rowCount: inStock.length } });
    return { buffer, rowCount: inStock.length };
  }
}
