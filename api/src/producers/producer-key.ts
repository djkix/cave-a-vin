import { normalizeLabel } from '../appellations/appellations.service';

/**
 * Clé d'un domaine : « Domaine Tempier » et « DOMAINE TEMPIER » partagent le même
 * descriptif. Seule source de la clé, côté api comme dans les routes.
 */
export const producerKeyOf = (producer: string): string => normalizeLabel(producer);
