import { matchDish } from './dish-filter';

describe('matchDish', () => {
  const dishes = ['Agneau de sept heures', 'Côte d’agneau grillée', 'Daube provençale'];

  it('trouve sans tenir compte des accents ni des majuscules, et rend le premier plat qui correspond', () => {
    expect(matchDish(dishes, 'AGNEAU')).toBe('Agneau de sept heures');
    expect(matchDish(dishes, 'provencale')).toBe('Daube provençale');
  });

  it('exige tous les mots dans un même plat', () => {
    expect(matchDish(dishes, 'agneau grillee')).toBe('Côte d’agneau grillée');
    expect(matchDish(dishes, 'agneau daube')).toBeNull();
  });

  it('ne trouve rien sans accords ou sans mot', () => {
    expect(matchDish(null, 'agneau')).toBeNull();
    expect(matchDish(dishes, '  ')).toBeNull();
  });
});
