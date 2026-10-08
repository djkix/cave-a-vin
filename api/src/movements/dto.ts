import { z } from 'zod';
import { locationIdSchema, locationInputSchema } from '../locations/location';

export const wineDraftSchema = z.object({
  producer: z.string().trim().min(1, 'Producteur requis'),
  cuvee: z.string().trim().nullish(),
  appellationRaw: z.string().trim().min(1, 'Appellation requise'),
  vintage: z.number().int().min(1900).max(new Date().getFullYear()).nullish(),
  color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT']),
  formatCl: z.number().int().positive().default(75),
});

export const createMovementSchema = z.object({
  idempotencyKey: z.string().uuid(),
  photoId: z.string().uuid().nullish(),
  wine: wineDraftSchema,
  quantity: z.number().int().positive('La quantité doit être positive'),
  priceUnitCents: z.number().int().nonnegative().nullish(),
  note: z.string().trim().max(500).nullish(),
  /** Emplacement de rangement, créé à la volée ; absent ou null = « Sans emplacement ». */
  location: locationInputSchema.nullish(),
});

export type CreateMovementInput = z.infer<typeof createMovementSchema>;

export const cancelMovementSchema = z.object({
  idempotencyKey: z
    .string({ invalid_type_error: 'idempotencyKey invalide', required_error: 'idempotencyKey invalide' })
    .uuid('idempotencyKey invalide'),
});

export type CancelMovementInput = z.infer<typeof cancelMovementSchema>;

export const createOutSchema = z.object({
  idempotencyKey: z
    .string({ required_error: 'idempotencyKey invalide', invalid_type_error: 'idempotencyKey invalide' })
    .uuid('idempotencyKey invalide'),
  wineId: z
    .string({ required_error: 'Vin invalide', invalid_type_error: 'Vin invalide' })
    .uuid('Vin invalide'),
  quantity: z
    .number({ required_error: 'La quantité doit être positive', invalid_type_error: 'La quantité doit être positive' })
    .int('La quantité doit être positive')
    .positive('La quantité doit être positive'),
  photoId: z.string({ invalid_type_error: 'Photo invalide' }).uuid('Photo invalide').nullish(),
  /**
   * D'où sort la bouteille : un emplacement, ou null pour « Sans emplacement ».
   * Champ absent (ancien client) : « Sans emplacement » s'il en a assez, sinon
   * la pré-sélection (exitDefault), sinon le premier endroit qui en a assez.
   */
  locationId: locationIdSchema.optional(),
});

export type CreateOutInput = z.infer<typeof createOutSchema>;

export const inventorySchema = z.object({
  idempotencyKey: z
    .string({ required_error: 'idempotencyKey invalide', invalid_type_error: 'idempotencyKey invalide' })
    .uuid('idempotencyKey invalide'),
  counted: z
    .number({ required_error: 'Nombre de bouteilles invalide', invalid_type_error: 'Nombre de bouteilles invalide' })
    .int('Nombre de bouteilles entier attendu')
    .min(0, 'Le nombre de bouteilles ne peut pas être négatif')
    // Au-delà, la colonne INTEGER déborde et la base répondrait par une erreur 500.
    .max(100000, 'Nombre de bouteilles trop élevé'),
  /**
   * Endroit compté : une baisse s'y applique (409 s'il n'y en a pas assez), une
   * hausse y va. Null = « Sans emplacement ». Champ absent (ancien client) :
   * hausse à « Sans emplacement », baisse comme une sortie sans emplacement.
   */
  locationId: locationIdSchema.optional(),
});

export type InventoryInput = z.infer<typeof inventorySchema>;

export const moveSchema = z.object({
  /** Facultative : un rejeu avec la même clé ne déplace rien de plus. */
  idempotencyKey: z.string({ invalid_type_error: 'idempotencyKey invalide' }).uuid('idempotencyKey invalide').optional(),
  from: z.string({ required_error: 'Emplacement invalide', invalid_type_error: 'Emplacement invalide' }).uuid('Emplacement invalide').nullable(),
  to: locationInputSchema,
  quantity: z
    .number({ required_error: 'La quantité doit être positive', invalid_type_error: 'La quantité doit être positive' })
    .int('La quantité doit être positive')
    .min(1, 'La quantité doit être positive')
    .max(100000, 'Nombre de bouteilles trop élevé'),
});

export type MoveInput = z.infer<typeof moveSchema>;
