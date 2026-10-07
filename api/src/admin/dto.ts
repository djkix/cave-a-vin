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

/** Part maximale du plafond mensuel qu'une cave peut dépenser (0 à 1 inclus). */
export const updateBudgetSchema = z.object(
  {
    caveShare: z
      .number({ invalid_type_error: INVALID_SHARE, required_error: INVALID_SHARE })
      .min(0, { message: INVALID_SHARE })
      .max(1, { message: INVALID_SHARE }),
  },
  { invalid_type_error: INVALID_SHARE, required_error: INVALID_SHARE },
);
