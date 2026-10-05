import { z } from 'zod';

const RANGE = 'La note doit être comprise entre 0 et 20';

/** Note de dégustation : de 0 à 20, par demi-point. */
export const ratingSchema = z.object({
  rating: z
    .number({ required_error: RANGE, invalid_type_error: RANGE })
    .min(0, RANGE)
    .max(20, RANGE)
    .refine((v) => Number.isInteger(v * 2), 'La note se donne par demi-point'),
});

export type RatingInput = z.infer<typeof ratingSchema>;
