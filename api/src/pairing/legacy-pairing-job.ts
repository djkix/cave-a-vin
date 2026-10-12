import { PrismaService } from '../prisma/prisma.service';
import { findProducerWines } from '../producers/producer-wines';
import { requestPairings, requestProducerProfiles } from './generation-requests';
import { PairingJobData, PRODUCER_JOB, ProducerJobData } from './pairing.queue';

/**
 * Travail de l'ancienne file `wine-pairing` (accords ou descriptif d'un seul
 * élément), resté en attente dans Redis à la mise à jour, ou mis en file par
 * une api pas encore mise à jour. Il n'appelle jamais Gemini : il s'assure
 * seulement que la demande existe en base, en attente si elle manquait. Le lot
 * suivant s'en charge. Une demande déjà présente (en attente, générée ou en
 * échec) est laissée telle quelle ; le travail aboutit toujours.
 */
export async function handleLegacyPairingJob(
  prisma: Pick<PrismaService, 'wine' | 'pairing' | 'producerProfile'>,
  job: { name: string; data: unknown },
): Promise<void> {
  if (job.name === PRODUCER_JOB) {
    const producerKey = (job.data as Partial<ProducerJobData> | null)?.producerKey;
    if (typeof producerKey !== 'string' || !producerKey) return;
    const wines = await findProducerWines(prisma, producerKey);
    if (!wines.length) return; // plus aucun vin de ce domaine
    await requestProducerProfiles(prisma, [{ producerKey, displayName: wines[0].producer }]);
    return;
  }
  if (job.name !== 'pairing') return;
  const wineId = (job.data as Partial<PairingJobData> | null)?.wineId;
  if (typeof wineId !== 'string' || !wineId) return;
  if (!(await prisma.wine.findUnique({ where: { id: wineId }, select: { id: true } }))) return; // vin supprimé
  await requestPairings(prisma, [wineId]);
}
