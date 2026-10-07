import { z } from 'zod';

export const updateAdminUserSchema = z
  .object({
    status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
    isAdmin: z.boolean().optional(),
  })
  .refine((v) => v.status !== undefined || v.isAdmin !== undefined, {
    message: 'Fournir status ou isAdmin',
  });

export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;

const INVALID_SHARE = 'La part par cave doit être comprise entre 0 et 1';
const INVALID_INVITED_SHARE = 'La part des caves invitées doit être comprise entre 0 et 1';

const share = (message: string) =>
  z.number({ invalid_type_error: message, required_error: message }).min(0, { message }).max(1, { message });

/**
 * Parts du plafond mensuel (0 à 1 inclus) : par cave, et pour l'ensemble des
 * caves invitées. L'une ou l'autre, ou les deux.
 */
export const updateBudgetSchema = z
  .object(
    { caveShare: share(INVALID_SHARE).optional(), invitedShare: share(INVALID_INVITED_SHARE).optional() },
    { invalid_type_error: INVALID_SHARE, required_error: INVALID_SHARE },
  )
  .refine((b) => b.caveShare !== undefined || b.invitedShare !== undefined, { message: INVALID_SHARE });
