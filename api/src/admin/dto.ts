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
