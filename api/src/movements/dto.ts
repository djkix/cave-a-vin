import { z } from 'zod';

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
});

export type CreateOutInput = z.infer<typeof createOutSchema>;

export const inventorySchema = z.object({
  idempotencyKey: z
    .string({ required_error: 'idempotencyKey invalide', invalid_type_error: 'idempotencyKey invalide' })
    .uuid('idempotencyKey invalide'),
  counted: z
    .number({ required_error: 'Nombre de bouteilles invalide', invalid_type_error: 'Nombre de bouteilles invalide' })
    .int('Nombre de bouteilles entier attendu')
    .min(0, 'Le nombre de bouteilles ne peut pas être négatif'),
});

export type InventoryInput = z.infer<typeof inventorySchema>;
