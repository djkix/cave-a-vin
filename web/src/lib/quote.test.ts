import {
  COTE_INVALID, formatCoteEuros, parisToday, parseCoteEuros, parseTransactions, quoteAge, quoteLine, quoteWarnings, TRANSACTIONS_INVALID,
} from './quote';

describe('cote : saisie', () => {
  it('lit des euros avec virgule ou point, en centimes', () => {
    expect(parseCoteEuros('85')).toBe(8500);
    expect(parseCoteEuros(' 85,5 ')).toBe(8550);
    expect(parseCoteEuros('85.05')).toBe(8505);
    expect(parseCoteEuros('100000')).toBe(10_000_000);
    expect(parseCoteEuros('0,01')).toBe(1);
  });
  it('refuse zéro, plus de 100 000 €, plus de deux décimales ou du texte, avec le message de l’api', () => {
    for (const t of ['', '0', '0,00', '100000,01', '85,555', 'abc', '-5', '1e3']) expect(parseCoteEuros(t)).toBe(COTE_INVALID);
    expect(COTE_INVALID).toBe('La cote doit être comprise entre 0,01 € et 100 000 €');
  });
  it('nombre de transactions : entier ≥ 0 ou vide', () => {
    expect(parseTransactions('')).toBeNull();
    expect(parseTransactions(' 12 ')).toBe(12);
    expect(parseTransactions('0')).toBe(0);
    for (const t of ['-1', '2,5', 'douze']) expect(parseTransactions(t)).toBe(TRANSACTIONS_INVALID);
  });
});

describe('cote : affichage', () => {
  it('euros sans centimes inutiles, jamais « 0 € » faute de valeur', () => {
    expect(formatCoteEuros(8500)).toBe('85 €');
    expect(formatCoteEuros(8550)).toBe('85,50 €');
    expect(formatCoteEuros(1_240_000)).toMatch(/^12\s400 €$/);
  });

  it('âge de la cote', () => {
    expect(quoteAge('2026-03-03', '2026-10-08')).toBe('il y a 7 mois');
    expect(quoteAge('2026-10-08', '2026-10-08')).toBe('aujourd’hui');
    expect(quoteAge('2026-10-07', '2026-10-08')).toBe('il y a 1 jour');
    expect(quoteAge('2026-09-10', '2026-10-08')).toBe('il y a 28 jours');
    expect(quoteAge('2026-09-08', '2026-10-08')).toBe('il y a 1 mois');
    expect(quoteAge('2025-10-08', '2026-10-08')).toBe('il y a 1 an');
    expect(quoteAge('2023-01-31', '2026-10-08')).toBe('il y a 3 ans');
  });

  it('ligne de la cote, comme la spec', () => {
    expect(quoteLine({ coteCents: 8500, nTransactions: 12, quotedOn: '2026-03-03' }, '2026-10-08'))
      .toBe('85 € — 12 transactions — cote du 3 mars 2026, il y a 7 mois');
    expect(quoteLine({ coteCents: 8500, nTransactions: 1, quotedOn: '2026-03-03' }, '2026-10-08'))
      .toBe('85 € — 1 transaction — cote du 3 mars 2026, il y a 7 mois');
    expect(quoteLine({ coteCents: 8500, nTransactions: null, quotedOn: '2026-03-03' }, '2026-10-08'))
      .toBe('85 € — cote du 3 mars 2026, il y a 7 mois');
  });

  it('avertissements : sous 5 transactions, au-delà de 12 mois', () => {
    const at = (nTransactions: number | null, quotedOn: string) => quoteWarnings({ nTransactions, quotedOn }, '2026-10-08');
    expect(at(12, '2026-03-03')).toEqual([]);
    expect(at(4, '2026-03-03')).toEqual(['Peu de transactions : ordre de grandeur']);
    expect(at(5, '2026-03-03')).toEqual([]);
    expect(at(0, '2026-03-03')).toEqual(['Peu de transactions : ordre de grandeur']);
    // Nombre inconnu : rien à signaler.
    expect(at(null, '2026-03-03')).toEqual([]);
    expect(at(12, '2025-10-08')).toEqual([]);
    expect(at(12, '2025-10-07')).toEqual(["Cote de plus d'un an"]);
    expect(at(2, '2020-01-01')).toEqual(['Peu de transactions : ordre de grandeur', "Cote de plus d'un an"]);
  });

  it('jour courant à Paris', () => {
    expect(parisToday(new Date('2026-10-07T22:30:00Z'))).toBe('2026-10-08');
    expect(parisToday(new Date('2026-10-07T21:30:00Z'))).toBe('2026-10-07');
  });

});
