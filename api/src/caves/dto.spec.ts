import { addMemberSchema, renameCaveSchema } from './dto';
import { updateBudgetSchema } from '../admin/dto';

describe('addMemberSchema', () => {
  it('normalise l’adresse (espaces, minuscules)', () => {
    expect(addMemberSchema.parse({ email: '  Jean.Dupont@Example.FR ' })).toEqual({ email: 'jean.dupont@example.fr' });
  });

  it('refuse une adresse invalide, vide ou absente avec un message en français', () => {
    for (const body of [{ email: 'pas-une-adresse' }, { email: '   ' }, {}, { email: 3 }, null]) {
      const r = addMemberSchema.safeParse(body);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe('Adresse e-mail invalide');
    }
  });
});

describe('renameCaveSchema', () => {
  it('nettoie le nom ; 1 à 80 caractères', () => {
    expect(renameCaveSchema.parse({ name: '  Ma cave  ' })).toEqual({ name: 'Ma cave' });
    expect(renameCaveSchema.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(renameCaveSchema.parse({ name: 'é'.repeat(80) })).toEqual({ name: 'é'.repeat(80) });
  });

  it('refuse vide, blanc, 81 caractères ou un non-texte', () => {
    for (const body of [{ name: '' }, { name: '  ' }, { name: 'x'.repeat(81) }, { name: 5 }, {}]) {
      const r = renameCaveSchema.safeParse(body);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe('Le nom de la cave doit faire de 1 à 80 caractères');
    }
  });
});

describe('updateBudgetSchema', () => {
  it('accepte 0, 1 et les valeurs entre les deux', () => {
    for (const caveShare of [0, 0.2, 1]) expect(updateBudgetSchema.parse({ caveShare })).toEqual({ caveShare });
  });

  it('refuse hors bornes ou un non-nombre', () => {
    for (const body of [{ caveShare: -0.01 }, { caveShare: 1.01 }, { caveShare: '0.2' }, { caveShare: null }, { caveShare: Number.NaN }, {}]) {
      const r = updateBudgetSchema.safeParse(body);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe('La part par cave doit être comprise entre 0 et 1');
    }
  });
});
