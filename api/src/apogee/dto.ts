import { z } from 'zod';

const year = (label: string) =>
  z.number({ required_error: `${label} requise`, invalid_type_error: `${label} invalide` }).int(`${label} : année entière attendue`);

export const manualApogeeSchema = z
  .object({
    min: year('Année de début').min(1900, 'Année de début trop ancienne').max(2200, 'Année de début trop lointaine'),
    max: year('Année de fin').min(1900, 'Année de fin trop ancienne').max(2200, 'Année de fin trop lointaine'),
  })
  .refine((d) => d.min <= d.max, { message: 'L’année de début doit précéder ou égaler l’année de fin', path: ['max'] });

export type ManualApogeeInput = z.infer<typeof manualApogeeSchema>;

export const vintageQualitySchema = z.object({
  region: z.string({ required_error: 'Région requise', invalid_type_error: 'Région invalide' }).trim().min(1, 'Région requise'),
  year: z
    .number({ required_error: 'Année requise', invalid_type_error: 'Année invalide' })
    .int('Année entière attendue')
    .min(1900, 'Année trop ancienne')
    // Lu à chaque validation, et non au chargement du module : l'api tourne
    // parfois d'une année sur l'autre sans redémarrer.
    .refine((y) => y <= new Date().getFullYear() + 1, 'Année dans le futur'),
  quality: z.enum(['GRAND', 'MOYEN', 'FAIBLE'], { errorMap: () => ({ message: 'Qualité inconnue' }) }),
});

export type VintageQualityInput = z.infer<typeof vintageQualitySchema>;

const guardYears = (label: string) =>
  z
    .number({ required_error: `${label} requise`, invalid_type_error: `${label} invalide` })
    .int(`${label} : nombre d’années entier attendu`)
    .min(0, `${label} : pas de garde négative`)
    .max(100, `${label} : 100 ans au plus`);

export const guardOverrideSchema = z
  .object({
    appellationId: z.string({ required_error: 'Appellation requise', invalid_type_error: 'Appellation invalide' }).uuid('Appellation invalide'),
    color: z.enum(['ROUGE', 'BLANC', 'ROSE', 'PETILLANT'], { errorMap: () => ({ message: 'Couleur inconnue' }) }).nullish(),
    min: guardYears('Garde minimale'),
    max: guardYears('Garde maximale'),
  })
  .refine((d) => d.min <= d.max, { message: 'La garde minimale doit être inférieure ou égale à la maximale', path: ['max'] });

export type GuardOverrideInput = z.infer<typeof guardOverrideSchema>;
