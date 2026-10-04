import { Apogee } from './api-client';
import { apogeeRange, apogeeReasonMessage, apogeeShortLabel, apogeeStatusLabel } from './apogee';

const a = (over: Partial<Apogee>): Apogee => ({ min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE', ...over });

it('formule la fourchette', () => {
  expect(apogeeRange(a({}))).toBe('À boire entre 2024 et 2036');
  expect(apogeeRange(a({ min: 2030, max: 2030 }))).toBe('À boire en 2030');
  expect(apogeeRange(a({ min: null, max: null, status: null, reason: 'NON_MILLESIME' }))).toBeNull();
});

it.each([
  ['TROP_JEUNE', 'Trop jeune — à partir de 2024', 'Trop jeune (2024)'],
  ['A_BOIRE', 'À boire — jusqu’en 2036', 'À boire 2024-2036'],
  ['A_BOIRE_VITE', 'À boire vite — 2036 est la dernière année', 'À boire vite'],
  ['PASSEE', 'Apogée passée depuis 2036', 'Apogée passée'],
] as const)('statut %s', (status, long, short) => {
  expect(apogeeStatusLabel(a({ status }))).toBe(long);
  expect(apogeeShortLabel(a({ status }))).toBe(short);
});

it('n’a pas de libellé sans estimation', () => {
  const none = a({ min: null, max: null, confidence: null, status: null, reason: 'GARDE_INCONNUE', source: null });
  expect(apogeeStatusLabel(none)).toBeNull();
  expect(apogeeShortLabel(none)).toBeNull();
});

it('explique chaque absence d’estimation', () => {
  expect(apogeeReasonMessage('NON_MILLESIME')).toBe('Vin non millésimé : saisis la fourchette si tu la connais');
  expect(apogeeReasonMessage('APPELLATION_INCONNUE')).toBe('Appellation non reconnue par le référentiel : saisis la fourchette');
  expect(apogeeReasonMessage('GARDE_INCONNUE')).toBe('Garde inconnue pour cette appellation : saisis la fourchette');
});
