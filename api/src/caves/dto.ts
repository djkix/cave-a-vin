import { z } from 'zod';

const INVALID_EMAIL = 'Adresse e-mail invalide';
const INVALID_NAME = 'Le nom de la cave doit faire de 1 à 80 caractères';

/** Adresse invitée, normalisée (espaces retirés, minuscules) comme à la connexion Google. */
export const addMemberSchema = z.object(
  {
    email: z
      .string({ invalid_type_error: INVALID_EMAIL, required_error: INVALID_EMAIL })
      .trim()
      .toLowerCase()
      .email({ message: INVALID_EMAIL }),
  },
  { invalid_type_error: INVALID_EMAIL, required_error: INVALID_EMAIL },
);

export const renameCaveSchema = z.object(
  {
    name: z
      .string({ invalid_type_error: INVALID_NAME, required_error: INVALID_NAME })
      .trim()
      .min(1, { message: INVALID_NAME })
      .max(80, { message: INVALID_NAME }),
  },
  { invalid_type_error: INVALID_NAME, required_error: INVALID_NAME },
);
