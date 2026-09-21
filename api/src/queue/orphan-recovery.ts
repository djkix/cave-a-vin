import { Queue } from 'bullmq';
import { ExtractionJobData } from './extraction.queue';

/**
 * États dans lesquels BullMQ va encore traiter le travail tout seul. « active »
 * en fait partie : si le worker précédent est mort en pleine extraction, BullMQ
 * détecte le travail bloqué et le rejoue de lui-même.
 */
const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children', 'paused']);

export interface OrphanRecoveryPrisma {
  photo: {
    findMany(args: unknown): Promise<{ id: string }[]>;
  };
}

export type OrphanRecoveryQueue = Pick<Queue<ExtractionJobData>, 'add' | 'getJob'>;

/**
 * La photo est sur le disque, mais la file vit dans Redis : un redémarrage du
 * conteneur, un Redis vidé ou un travail abandonné laissent donc une photo « en
 * attente » que plus personne ne viendra analyser — elle disparaît de la revue
 * groupée sans que rien ne le signale. C'est la panne la plus sournoise du flux
 * différé, et la seule que l'utilisateur ne peut pas rattraper lui-même.
 *
 * Au démarrage du worker, on remet donc en file toute photo en attente qui n'a
 * plus de travail vivant. L'opération est idempotente : les photos dont le travail
 * est encore vivant sont laissées telles quelles.
 */
export async function requeueOrphanPhotos(
  prisma: OrphanRecoveryPrisma,
  queue: OrphanRecoveryQueue,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  const photos = await prisma.photo.findMany({
    where: { status: { in: ['PENDING', 'PROCESSING'] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let requeued = 0;
  for (const { id } of photos) {
    const job = await queue.getJob(id);
    if (job) {
      const state = await job.getState();
      if (LIVE_STATES.has(state)) continue;
      // Un travail terminé ou en échec garde son identifiant (removeOnFail garde
      // les mille derniers) : `add` avec le même jobId serait ignoré en silence.
      // Il faut donc retirer l'ancien avant de remettre la photo en file.
      try {
        await job.remove();
      } catch (e) {
        log(`Photo ${id} : ancien travail non supprimable (${(e as Error).message}), reprise ignorée`);
        continue;
      }
    }
    await queue.add('extract', { photoId: id }, { jobId: id });
    requeued += 1;
  }

  if (requeued > 0) log(`Reprise au démarrage : ${requeued} photo(s) en attente remise(s) en file`);
  return requeued;
}
