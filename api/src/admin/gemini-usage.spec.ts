import { aggregateGeminiUsage, parisDay } from './gemini-usage';

const NOW = new Date('2026-10-08T10:00:00.000Z'); // 12:00 à Paris

const call = (createdAt: string, usage: string, outcome: string, httpStatus: number | null = null, costCents = 0) => ({
  createdAt: new Date(createdAt),
  usage,
  outcome,
  httpStatus,
  costCents,
});

describe('parisDay', () => {
  it('donne le jour à Paris, pas en UTC', () => {
    expect(parisDay(new Date('2026-10-07T22:30:00.000Z'))).toBe('2026-10-08'); // 00:30 à Paris
    expect(parisDay(new Date('2026-10-07T21:59:00.000Z'))).toBe('2026-10-07');
    expect(parisDay(new Date('2026-12-31T23:30:00.000Z'))).toBe('2027-01-01'); // heure d'hiver : UTC+1
  });
});

describe('aggregateGeminiUsage', () => {
  it('regroupe par jour de Paris et par usage, du plus récent au plus ancien', () => {
    const r = aggregateGeminiUsage(
      [
        call('2026-10-08T08:00:00.000Z', 'ACCORDS', 'OK', null, 1),
        call('2026-10-07T22:30:00.000Z', 'LECTURE_ENTREE', 'REFUSE', 503), // 8 oct. à Paris
        call('2026-10-07T21:30:00.000Z', 'LECTURE_ENTREE', 'REFUSE', 429), // 7 oct. à Paris
        call('2026-10-07T12:00:00.000Z', 'LECTURE_ENTREE', 'OK', null, 3),
        call('2026-10-07T12:00:00.000Z', 'LECTURE_ENTREE', 'ERREUR', null, 2),
        call('2026-10-08T09:00:00.000Z', 'LECTURE_ENTREE', 'OK', null, 4),
      ],
      NOW,
      7,
    );
    expect(r.rows).toEqual([
      { day: '2026-10-08', usage: 'LECTURE_ENTREE', ok: 1, refused503: 1, refused429: 0, errors: 0, costCents: 4 },
      { day: '2026-10-08', usage: 'ACCORDS', ok: 1, refused503: 0, refused429: 0, errors: 0, costCents: 1 },
      { day: '2026-10-07', usage: 'LECTURE_ENTREE', ok: 1, refused503: 0, refused429: 1, errors: 1, costCents: 5 },
    ]);
    expect(r.totals).toEqual({ ok: 3, refused: 2, errors: 1, costCents: 10 });
  });

  it('ne garde que les `days` derniers jours de Paris, aujourd’hui compris', () => {
    const r = aggregateGeminiUsage(
      [
        call('2026-10-01T22:30:00.000Z', 'ACCORDS', 'OK'), // 2 oct. à Paris : dans les 7 jours
        call('2026-10-01T21:30:00.000Z', 'ACCORDS', 'OK'), // 1er oct. à Paris : hors période
      ],
      NOW,
      7,
    );
    expect(r.rows.map((row) => row.day)).toEqual(['2026-10-02']);
    expect(aggregateGeminiUsage([call('2026-10-07T12:00:00.000Z', 'ACCORDS', 'OK')], NOW, 1).rows).toEqual([]);
    // Après aujourd'hui (horloge décalée) : hors période aussi.
    expect(aggregateGeminiUsage([call('2026-10-08T22:30:00.000Z', 'ACCORDS', 'OK')], NOW, 7).rows).toEqual([]);
  });

  it('période vide : aucune ligne, totaux à zéro', () => {
    expect(aggregateGeminiUsage([], NOW, 7)).toEqual({ rows: [], totals: { ok: 0, refused: 0, errors: 0, costCents: 0 } });
  });
});
