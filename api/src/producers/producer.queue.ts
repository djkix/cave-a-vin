import { createHash } from 'node:crypto';
import { PairingQueueLike, scheduleUnique } from '../pairing/pairing.queue';

/** Nom des travaux de descriptif dans la file `wine-pairing`. */
export const PRODUCER_JOB = 'producer';

/** Un identifiant par domaine ; la clé contient des espaces, d'où son empreinte sha1. */
export const producerJobId = (producerKey: string) => `producer-${createHash('sha1').update(producerKey).digest('hex')}`;

/** Même politique que les accords : jamais deux générations du même domaine dans la file. */
export function scheduleProducer(queue: PairingQueueLike, producerKey: string): Promise<void> {
  return scheduleUnique(queue, PRODUCER_JOB, { producerKey }, producerJobId(producerKey));
}
