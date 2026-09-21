import { computeMatchKey } from './match-key';

describe('computeMatchKey', () => {
  it('normalizes case, accents, punctuation and stop words', () => {
    const a = computeMatchKey({ producer: 'Domaine Leflaive', cuvee: 'Clavoillon', appellationRaw: 'Puligny-Montrachet 1er Cru', vintage: 2019, color: 'BLANC', formatCl: 75 });
    const b = computeMatchKey({ producer: 'LEFLAIVE', cuvee: 'clavoillon', appellationRaw: 'puligny montrachet 1er cru', vintage: 2019, color: 'BLANC', formatCl: 75 });
    expect(a).toBe(b);
    expect(a).toBe('leflaive|clavoillon|puligny montrachet 1er cru|2019|BLANC|75');
  });

  it('distinguishes vintage and format', () => {
    const base = { producer: 'Château Rayas', appellationRaw: 'Châteauneuf-du-Pape', color: 'ROUGE' as const, formatCl: 75 };
    expect(computeMatchKey({ ...base, vintage: 2010 })).not.toBe(computeMatchKey({ ...base, vintage: 2011 }));
    expect(computeMatchKey({ ...base, vintage: 2010 })).not.toBe(computeMatchKey({ ...base, vintage: 2010, formatCl: 150 }));
  });

  it('encodes a missing vintage as NV', () => {
    expect(computeMatchKey({ producer: 'Krug', appellationRaw: 'Champagne', color: 'PETILLANT', formatCl: 75 })).toBe('krug||champagne|NV|PETILLANT|75');
  });
});
