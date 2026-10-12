import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { requestPairings } from './generation-requests';

/** Nouveau vin : sa demande d'accords, en attente, part dans le prochain lot du worker. */
@Injectable()
export class PairingScheduler {
  constructor(private readonly prisma: PrismaService) {}

  async schedule(wineId: string): Promise<void> {
    await requestPairings(this.prisma, [wineId]);
  }
}

@Injectable()
export class PairingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * « Régénérer » : l'accord repasse en attente tout de suite (l'interface
   * affiche « en préparation » dès la réponse) et rejoint le prochain lot du
   * worker, comme une nouvelle demande. Jamais d'appel direct à Gemini. La
   * réservation d'un lot en cours est levée : sa réponse, désormais périmée,
   * n'est pas enregistrée (ses écritures exigent la réservation). Vin de
   * la cave courante seulement : celui d'une autre cave est inexistant (404).
   */
  async regenerate(caveId: string, wineId: string): Promise<void> {
    const wine = await this.prisma.wine.findFirst({ where: { id: wineId, caveId }, select: { id: true } });
    if (!wine) throw new NotFoundException('Vin introuvable');
    const requestedAt = new Date();
    await this.prisma.pairing.upsert({
      where: { wineId },
      create: { wineId, requestedAt },
      update: { status: 'PENDING', errorMessage: null, requestedAt, attempts: 0, nextAttemptAt: null, reservedUntil: null },
    });
  }
}
