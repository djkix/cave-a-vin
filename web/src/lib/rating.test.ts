import { formatRating, parseRating } from './rating';

it('formate une note à la française', () => {
  expect(formatRating(16.5)).toBe('16,5 / 20');
  expect(formatRating(14)).toBe('14 / 20');
});

it('accepte une virgule ou un point, par demi-point, de 0 à 20', () => {
  expect(parseRating('16,5')).toBe(16.5);
  expect(parseRating(' 16.5 ')).toBe(16.5);
  expect(parseRating('0')).toBe(0);
  expect(parseRating('20')).toBe(20);
});

it('refuse le reste avec un message français', () => {
  expect(parseRating('')).toBe('La note doit être comprise entre 0 et 20');
  expect(parseRating('21')).toBe('La note doit être comprise entre 0 et 20');
  expect(parseRating('seize')).toBe('La note doit être comprise entre 0 et 20');
  expect(parseRating('16,3')).toBe('La note se donne par demi-point');
});
