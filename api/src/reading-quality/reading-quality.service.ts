import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { correctedFields, ReadingQuality, summarize } from './reading-quality';

export const READING_QUALITY_DAYS = 90;

@Injectable()
export class ReadingQualityService {
  constructor(private readonly prisma: PrismaService) {}

  async compute(now = new Date()): Promise<ReadingQuality & { days: number }> {
    const since = new Date(now.getTime() - READING_QUALITY_DAYS * 24 * 3600 * 1000);
    const entries = await this.prisma.movement.findMany({
      where: { type: 'IN', occurredAt: { gte: since }, confirmedWine: { not: Prisma.DbNull } },
      select: { confirmedWine: true, photo: { select: { rawExtraction: true } } },
    });
    const perEntry = entries.map((m) => correctedFields(m.photo?.rawExtraction ?? null, m.confirmedWine as Record<string, unknown>));
    return { days: READING_QUALITY_DAYS, ...summarize(perEntry) };
  }
}
