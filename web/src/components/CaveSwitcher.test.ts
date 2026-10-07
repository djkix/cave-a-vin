import { pathAfterCaveSwitch } from './CaveSwitcher';

it('garde les listes valables pour tout rôle et l’administration', () => {
  for (const p of ['/', '/cave', '/stats', '/admin']) {
    expect(pathAfterCaveSwitch(p, false)).toBe(p);
    expect(pathAfterCaveSwitch(p, true)).toBe(p);
  }
});

it('garde une page réservée pour un propriétaire, la quitte pour un membre', () => {
  for (const p of ['/entree', '/sortie', '/journal', '/a-confirmer', '/membres']) {
    expect(pathAfterCaveSwitch(p, true)).toBe(p);
    expect(pathAfterCaveSwitch(p, false)).toBe('/');
  }
});

it('quitte la page d’un vin ou d’une photo de l’ancienne cave', () => {
  for (const p of ['/cave/w1', '/entree/p1', '/sortie/p1']) {
    expect(pathAfterCaveSwitch(p, true)).toBe('/');
  }
});
