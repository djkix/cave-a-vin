import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiJournal } from '../vision/gemini-journal';
import { GeminiUsageRow, GeminiUsageTotals, aggregateGeminiUsage, usageSince } from './gemini-usage';

export interface GeminiUsageReport {
  rows: GeminiUsageRow[];
  totals: GeminiUsageTotals;
  pause: { until: string | null; reason: string | null };
}

/** Consommation Gemini (journal `gemini_call`, toutes caves) et pause commune en cours. */
@Injectable()
export class GeminiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: GeminiJournal,
  ) {}

  async report(days: number, now = new Date()): Promise<GeminiUsageReport> {
    const [calls, pause] = await Promise.all([
      this.prisma.geminiCall.findMany({
        where: { createdAt: { gte: usageSince(now, days), lte: now } },
        select: { createdAt: true, usage: true, outcome: true, httpStatus: true, costCents: true },
      }),
      this.journal.currentPause(now),
    ]);
    return {
      ...aggregateGeminiUsage(calls, now, days),
      pause: { until: pause?.until.toISOString() ?? null, reason: pause?.reason ?? null },
    };
  }
}
