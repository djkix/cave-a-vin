import { z } from 'zod';

export const PRODUCER_DESCRIPTION_LENGTH = 2000;
const LENGTH = `Le descriptif doit faire entre 1 et ${PRODUCER_DESCRIPTION_LENGTH} caractères`;

/** Descriptif saisi à la main : 1 à 2000 caractères une fois rogné. */
export const producerDescriptionSchema = z.object({
  description: z
    .string({ required_error: LENGTH, invalid_type_error: LENGTH })
    .trim()
    .min(1, LENGTH)
    .max(PRODUCER_DESCRIPTION_LENGTH, LENGTH),
});

export type ProducerDescriptionInput = z.infer<typeof producerDescriptionSchema>;
