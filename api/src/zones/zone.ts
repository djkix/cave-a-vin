import { z } from 'zod';

export const ZONE_NOT_FOUND = 'Zone introuvable';
export const ZONE_NAME_TAKEN = 'Une zone porte déjà ce nom';
export const ZONE_STOCKED = 'Des bouteilles sont encore rangées dans cette zone';
export const ZONE_PHOTO_NOT_FOUND = 'Photo introuvable';
export const ZONE_ARCHIVED_TAKEN = 'Cette zone a été supprimée ; rangez ces bouteilles ailleurs';
export const PHOTO_TOO_LARGE = 'Photo trop lourde (15 Mo au plus)';
export const INVALID_ZONE_NAME = 'Le nom de la zone doit faire de 1 à 40 caractères';
export const INVALID_INDICATION = 'L\'indication fait 300 caractères au plus';
export const INVALID_ORDER = 'Ordre des zones invalide';
export const ZONE_NAME_MAX = 40;
export const INDICATION_MAX = 300;

const name = z
  .string({ invalid_type_error: INVALID_ZONE_NAME, required_error: INVALID_ZONE_NAME })
  .trim()
  .min(1, INVALID_ZONE_NAME)
  .max(ZONE_NAME_MAX, INVALID_ZONE_NAME);

/** Indication nettoyée ; vide = aucune (null). */
const indication = z
  .string({ invalid_type_error: INVALID_INDICATION })
  .trim()
  .max(INDICATION_MAX, INVALID_INDICATION)
  .nullish()
  .transform((v) => (v ? v : null));

export const createZoneSchema = z.object({ name, indication }, { invalid_type_error: INVALID_ZONE_NAME, required_error: INVALID_ZONE_NAME });
export type CreateZoneInput = { name: string; indication?: string | null };

/** Champs absents : inchangés ; `indication: null` ou vide l'efface. L'ordre se change par POST …/zones/order. */
export const updateZoneSchema = z.object(
  { name: name.optional(), indication: indication.optional() },
  { invalid_type_error: INVALID_ZONE_NAME, required_error: INVALID_ZONE_NAME },
);
export type UpdateZoneInput = { name?: string; indication?: string | null };

/** Nouvel ordre d'affichage : les zones de la cave, de la première à la dernière. */
export const zoneOrderSchema = z.object(
  {
    ids: z
      .array(z.string({ invalid_type_error: INVALID_ORDER }).uuid(INVALID_ORDER), { invalid_type_error: INVALID_ORDER, required_error: INVALID_ORDER })
      .max(1000, INVALID_ORDER)
      .refine((ids) => new Set(ids).size === ids.length, INVALID_ORDER),
  },
  { invalid_type_error: INVALID_ORDER, required_error: INVALID_ORDER },
);

/** Zone telle que l'api la rend : la photo se lit par GET /api/caves/zones/:id/photo. */
export interface ZoneView { id: string; name: string; indication: string | null; hasPhoto: boolean; sortOrder: number }

export function zoneView(z: { id: string; name: string; indication: string | null; photoPath: string | null; sortOrder: number }): ZoneView {
  return { id: z.id, name: z.name, indication: z.indication, hasPhoto: z.photoPath != null, sortOrder: z.sortOrder };
}

/** Chemin de la photo d'une zone, relatif à PHOTO_STORAGE_DIR. */
export const zonePhotoPath = (id: string) => `zones/${id}.jpg`;
