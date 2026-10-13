import { z } from 'zod';

export const ZONE_NOT_FOUND = 'Zone introuvable';
export const ZONE_NAME_TAKEN = 'Une zone porte déjà ce nom';
export const ZONE_STOCKED = 'Des bouteilles sont encore rangées dans cette zone';
export const ZONE_PHOTO_NOT_FOUND = 'Photo introuvable';
export const ZONE_ARCHIVED_TAKEN = 'Cette zone a été supprimée ; rangez ces bouteilles ailleurs';
export const PLAN_NOT_FOUND = 'Plan introuvable';
export const PLAN_MISSING = 'Ajoutez d\'abord un plan de la cave';
export const INVALID_MARKER = 'Position invalide sur le plan';
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

/**
 * Zone telle que l'api la rend : la photo se lit par GET /api/caves/zones/:id/photo ;
 * `marker` : son repère sur le plan de la cave (fractions de la largeur et de la
 * hauteur), null sans repère. Gardé quand le plan est retiré : il ne s'affiche
 * qu'avec un plan.
 */
export interface ZoneView {
  id: string; name: string; indication: string | null; hasPhoto: boolean; sortOrder: number; marker: { x: number; y: number } | null;
}

export function zoneView(z: {
  id: string; name: string; indication: string | null; photoPath: string | null; sortOrder: number; planX: number | null; planY: number | null;
}): ZoneView {
  return {
    id: z.id, name: z.name, indication: z.indication, hasPhoto: z.photoPath != null, sortOrder: z.sortOrder,
    marker: z.planX != null && z.planY != null ? { x: z.planX, y: z.planY } : null,
  };
}

/** Chemin de la photo d'une zone, relatif à PHOTO_STORAGE_DIR. */
export const zonePhotoPath = (id: string) => `zones/${id}.jpg`;

/** Chemin du plan d'une cave, relatif à PHOTO_STORAGE_DIR. */
export const planPath = (caveId: string) => `plans/${caveId}.jpg`;
/** Plus grand côté du plan normalisé, en pixels. */
export const PLAN_MAX_SIDE = 2400;

/** Repère d'une zone : deux nombres entre 0 et 1 (fractions de la largeur et de la hauteur du plan). */
const fraction = z.number({ invalid_type_error: INVALID_MARKER, required_error: INVALID_MARKER }).min(0, INVALID_MARKER).max(1, INVALID_MARKER);
export const markerSchema = z.object({ x: fraction, y: fraction }, { invalid_type_error: INVALID_MARKER, required_error: INVALID_MARKER });

/** Plan de la cave tel que l'api le rend : taille en pixels, date du dernier envoi (ISO). */
export interface PlanMeta { width: number; height: number; updatedAt: string }
/** Repère affiché : `number` = rang (à partir de 1) parmi les zones non archivées qui ont un repère, dans l'ordre d'affichage. */
export interface PlanMarker { zoneId: string; name: string; number: number; x: number; y: number }
