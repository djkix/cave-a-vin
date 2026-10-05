import { VisionBatchMismatchError } from '../vision/gemini-vision.provider';
import { EntryBatchProcessor } from './entry-batch.processor';
import { VisionBudgetExceededError } from './vision-budget.service';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const at = (deltaMs: number) => new Date(NOW.getTime() + deltaMs);
const GEMINI_503 = new Error('[503 Service Unavailable] This model is currently experiencing high demand.');
const BAD_KEY = new Error('[400 Bad Request] API key not valid. Please pass a valid API key.');

type Row = {
  id: string;
  purpose: 'ENTRY' | 'EXIT';
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';
  createdAt: Date;
  nextAttemptAt: Date | null;
  dismissedAt: Date | null;
  attempts: number;
  errorMessage: string | null;
  rawExtraction?: unknown;
  model?: string | null;
  latencyMs?: number | null;
  costCents?: number | null;
};

/** Interprète le sous-ensemble de `where` Prisma qu'utilise le processeur. */
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as any[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null;
    if (cond instanceof Date) return value?.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      if ('in' in cond) return cond.in.includes(value);
      if ('lte' in cond) return value !== null && value.getTime() <= cond.lte.getTime();
      if ('equals' in cond) return value === cond.equals;
      throw new Error(`condition non gérée par le faux : ${JSON.stringify(cond)}`);
    }
    return value === cond;
  });
}

function isCandidate(r: Row, now: Date) {
  return (
    r.purpose === 'ENTRY' &&
    r.status === 'PENDING' &&
    r.dismissedAt === null &&
    (r.nextAttemptAt === null || r.nextAttemptAt.getTime() <= now.getTime())
  );
}

function harness() {
  const rows: Row[] = [];
  const updateMany = jest.fn(async ({ where, data }: any) => {
    const hit = rows.filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  });
  const prisma: any = {
    photo: {
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        expect(orderBy).toEqual({ createdAt: 'asc' });
        return rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take)
          .map((r) => ({ ...r }));
      }),
      updateMany,
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('photo absente');
        return Object.assign(row, data);
      }),
    },
    // La réservation est du SQL brut (FOR UPDATE SKIP LOCKED) : le faux en reprend la
    // sémantique ; la vraie requête est couverte par le test d'intégration.
    $transaction: jest.fn(async (fn: any) =>
      fn({
        $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          const now = values.find((v) => v instanceof Date) as Date;
          return rows
            .filter((r) => isCandidate(r, now))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, 8)
            .map((r) => ({ id: r.id, attempts: r.attempts }));
        }),
        photo: { updateMany },
      }),
    ),
  };
  const missing = new Set<string>();
  const photos = {
    readNormalized: jest.fn(async (id: string) => {
      if (missing.has(id)) throw Object.assign(new Error(`ENOENT: ${id}.jpg`), { code: 'ENOENT' });
      return Buffer.from(`img-${id}`);
    }),
  };
  const item = (i: number) => ({ raw: { image: i + 1, producteur: `P${i}` }, extraction: { producer: { value: `P${i}`, confidence: 1 } } });
  const vision = {
    extractWineLabels: jest.fn(async (images: Array<{ data: Buffer; mimeType: string }>): Promise<any> => ({
      items: images.map((_, i) => item(i)),
      model: 'gemini-test',
      latencyMs: 900,
      costCents: 10,
    })),
    extractWineLabel: jest.fn(async (image: Buffer): Promise<any> => ({
      raw: { seul: image.toString() },
      extraction: { producer: { value: 'seul', confidence: 1 } },
      model: 'gemini-test',
      latencyMs: 300,
      costCents: 2,
    })),
  };
  const budget = { assertUnderCap: jest.fn(async () => undefined) };
  const processor = new EntryBatchProcessor(prisma, photos as any, vision as any, budget as any);
  let seq = 0;
  const add = (over: Partial<Row> = {}): Row => {
    const row: Row = {
      id: `p${++seq}`,
      purpose: 'ENTRY',
      status: 'PENDING',
      createdAt: at(-5_000 + seq), // récentes, dans l'ordre de création
      nextAttemptAt: null,
      dismissedAt: null,
      attempts: 0,
      errorMessage: null,
      ...over,
    };
    rows.push(row);
    return row;
  };
  const addMany = (n: number, over: Partial<Row> = {}) => Array.from({ length: n }, () => add(over));
  return { rows, prisma, photos, vision, budget, processor, add, addMany, missing };
}

describe('EntryBatchProcessor.tick — sélection', () => {
  it('7 photos récentes : rien ne part', async () => {
    const h = harness();
    h.addMany(7);
    expect(await h.processor.tick(NOW)).toEqual({ processed: 0 });
    expect(h.vision.extractWineLabels).not.toHaveBeenCalled();
    expect(h.rows.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('8 photos : un lot de 8 part', async () => {
    const h = harness();
    h.addMany(8);
    expect(await h.processor.tick(NOW)).toEqual({ processed: 8 });
    expect(h.vision.extractWineLabels).toHaveBeenCalledTimes(1);
    expect(h.vision.extractWineLabels.mock.calls[0][0]).toHaveLength(8);
  });

  it('10 photos : seules les 8 plus anciennes partent', async () => {
    const h = harness();
    const all = h.addMany(10);
    await h.processor.tick(NOW);
    expect(all.slice(0, 8).every((r) => r.status === 'DONE')).toBe(true);
    expect(all.slice(8).every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('une seule photo de 46 s : un lot part', async () => {
    const h = harness();
    const p = h.add({ createdAt: at(-46_000) });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 1 });
    expect(p.status).toBe('DONE');
  });

  it('une photo reportée dont l’heure est passée : un lot part', async () => {
    const h = harness();
    const p = h.add({ nextAttemptAt: at(-1_000), attempts: 1 });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 1 });
    expect(p.status).toBe('DONE');
  });

  it('une photo reportée dont l’heure n’est pas venue n’est pas candidate', async () => {
    const h = harness();
    h.add({ createdAt: at(-60_000), nextAttemptAt: at(10_000), attempts: 1 });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 0 });
  });

  it('exclut les photos écartées et les photos de sortie', async () => {
    const h = harness();
    h.add({ createdAt: at(-60_000), dismissedAt: at(-1_000) });
    h.add({ createdAt: at(-60_000), purpose: 'EXIT' });
    expect(await h.processor.tick(NOW)).toEqual({ processed: 0 });
    expect(h.vision.extractWineLabels).not.toHaveBeenCalled();
  });
});

describe('EntryBatchProcessor.tick — résultat du lot', () => {
  it('lot correct : chaque photo DONE avec sa lecture, le modèle et le coût partagé', async () => {
    const h = harness();
    const all = h.addMany(8);
    await h.processor.tick(NOW);
    all.forEach((r, i) => {
      expect(r.status).toBe('DONE');
      expect(r.rawExtraction).toEqual({ image: i + 1, producteur: `P${i}` });
      expect(r.model).toBe('gemini-test');
      expect(r.latencyMs).toBe(900);
      expect(r.costCents).toBe(2); // ceil(10 / 8)
      expect(r.errorMessage).toBeNull();
      expect(r.nextAttemptAt).toBeNull();
    });
  });

  it('envoie les images dans l’ordre des photos, en JPEG', async () => {
    const h = harness();
    const all = h.addMany(8);
    await h.processor.tick(NOW);
    const images = h.vision.extractWineLabels.mock.calls[0][0];
    expect(images.map((i: any) => i.data.toString())).toEqual(all.map((r) => `img-${r.id}`));
    expect(images.every((i: any) => i.mimeType === 'image/jpeg')).toBe(true);
  });

  it('un item invalide ne fait échouer que sa photo', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.vision.extractWineLabels.mockImplementationOnce(async (images: any[]) => ({
      items: images.map((_, i) =>
        i === 3 ? { error: 'Lecture de l’étiquette inexploitable' } : { raw: { image: i + 1 }, extraction: {} as any },
      ),
      model: 'gemini-test',
      latencyMs: 900,
      costCents: 8,
    }));
    await h.processor.tick(NOW);
    expect(all[3].status).toBe('FAILED');
    expect(all[3].errorMessage).toBe('Lecture de l’étiquette inexploitable');
    expect(all.filter((r) => r.status === 'DONE')).toHaveLength(7);
  });

  it('lot mélangé : chaque photo est relue seule, avec son propre coût', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.vision.extractWineLabels.mockRejectedValueOnce(new VisionBatchMismatchError('Sortie du modèle invalide (indice dupliqué)'));
    expect(await h.processor.tick(NOW)).toEqual({ processed: 8 });
    expect(h.vision.extractWineLabel).toHaveBeenCalledTimes(8);
    all.forEach((r) => {
      expect(r.status).toBe('DONE');
      expect(r.rawExtraction).toEqual({ seul: `img-${r.id}` }); // jamais la lecture d'une autre photo
      expect(r.costCents).toBe(2);
      expect(r.latencyMs).toBe(300);
    });
  });

  it('lot mélangé : une relecture en panne ne reporte que sa photo', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.vision.extractWineLabels.mockRejectedValueOnce(new VisionBatchMismatchError('Sortie du modèle invalide (indice manquant)'));
    h.vision.extractWineLabel.mockImplementation(async (image: Buffer) => {
      if (image.toString() === `img-${all[2].id}`) throw GEMINI_503;
      return { raw: {}, extraction: {} as any, model: 'm', latencyMs: 1, costCents: 1 };
    });
    await h.processor.tick(NOW);
    expect(all[2].status).toBe('PENDING');
    expect(all[2].attempts).toBe(1);
    expect(all.filter((r) => r.status === 'DONE')).toHaveLength(7);
  });

  it('une image introuvable fait échouer sa seule photo', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.missing.add(all[5].id);
    await h.processor.tick(NOW);
    expect(all[5].status).toBe('FAILED');
    expect(all[5].errorMessage).toBe('Image introuvable');
    expect(h.vision.extractWineLabels.mock.calls[0][0]).toHaveLength(7);
    expect(all.filter((r) => r.status === 'DONE')).toHaveLength(7);
    expect(all[6].costCents).toBe(2); // ceil(10 / 7)
  });
});

describe('EntryBatchProcessor.tick — pannes', () => {
  it('panne passagère : tout le lot repart en attente, première attente 30 s', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.vision.extractWineLabels.mockRejectedValueOnce(GEMINI_503);
    expect(await h.processor.tick(NOW)).toEqual({ processed: 8 });
    all.forEach((r) => {
      expect(r.status).toBe('PENDING');
      expect(r.attempts).toBe(1);
      expect(r.nextAttemptAt).toEqual(at(30_000));
      expect(r.errorMessage).toBe('Analyse reportée : service Gemini momentanément saturé, reprise automatique');
    });
  });

  it('l’attente croît avec les tentatives : 2 échecs passés → 2 min', async () => {
    const h = harness();
    const p = h.add({ createdAt: at(-600_000), attempts: 2, nextAttemptAt: at(-1) });
    h.vision.extractWineLabels.mockRejectedValueOnce(GEMINI_503);
    await h.processor.tick(NOW);
    expect(p.attempts).toBe(3);
    expect(p.nextAttemptAt).toEqual(at(120_000));
  });

  it('abandonne après EXTRACTION_ATTEMPTS tentatives', async () => {
    const h = harness();
    const p = h.add({ createdAt: at(-600_000), attempts: 999, nextAttemptAt: at(-1) });
    h.vision.extractWineLabels.mockRejectedValueOnce(GEMINI_503);
    await h.processor.tick(NOW);
    expect(p.status).toBe('FAILED');
    expect(p.attempts).toBe(1000);
    expect(p.nextAttemptAt).toBeNull();
    expect(p.errorMessage).toBe(
      'Analyse reportée : service Gemini momentanément saturé, reprise automatique — abandon après 1000 tentatives',
    );
  });

  it('erreur définitive : tout le lot FAILED avec le message', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.vision.extractWineLabels.mockRejectedValueOnce(BAD_KEY);
    await h.processor.tick(NOW);
    all.forEach((r) => {
      expect(r.status).toBe('FAILED');
      expect(r.errorMessage).toBe(BAD_KEY.message);
      expect(r.nextAttemptAt).toBeNull();
    });
  });

  it('plafond atteint : aucun appel, le lot est reporté avec le motif du plafond', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.budget.assertUnderCap.mockRejectedValueOnce(new VisionBudgetExceededError());
    await h.processor.tick(NOW);
    expect(h.vision.extractWineLabels).not.toHaveBeenCalled();
    all.forEach((r) => {
      expect(r.status).toBe('PENDING');
      expect(r.attempts).toBe(1);
      expect(r.errorMessage).toContain('Plafond mensuel');
    });
  });

  it('ne laisse jamais sortir d’exception : erreur d’écriture → lot remis en attente', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.prisma.photo.update.mockImplementationOnce(async () => {
      throw new Error('connexion perdue');
    });
    await expect(h.processor.tick(NOW)).resolves.toEqual({ processed: 8 });
    expect(all.every((r) => r.status !== 'PROCESSING')).toBe(true);
  });

  it('ne laisse jamais sortir d’exception, même si la base est injoignable', async () => {
    const h = harness();
    h.prisma.photo.updateMany.mockRejectedValue(new Error('base injoignable'));
    await expect(h.processor.tick(NOW)).resolves.toEqual({ processed: 0 });
  });
});

describe('EntryBatchProcessor.tick — réservation', () => {
  it('réserve les photos PROCESSING avec une échéance de 5 min avant l’appel', async () => {
    const h = harness();
    const all = h.addMany(8);
    h.vision.extractWineLabels.mockImplementationOnce(async () => {
      all.forEach((r) => {
        expect(r.status).toBe('PROCESSING');
        expect(r.nextAttemptAt).toEqual(at(5 * 60_000));
      });
      throw BAD_KEY;
    });
    await h.processor.tick(NOW);
    expect(h.vision.extractWineLabels).toHaveBeenCalled();
  });

  it('reprend les photos PROCESSING dont l’échéance est passée', async () => {
    const h = harness();
    const stale = h.add({ status: 'PROCESSING', nextAttemptAt: at(-1) });
    const live = h.add({ status: 'PROCESSING', nextAttemptAt: at(60_000) });
    const exit = h.add({ status: 'PROCESSING', nextAttemptAt: at(-1), purpose: 'EXIT' });
    await h.processor.tick(NOW);
    expect(stale.status).toBe('PENDING');
    expect(stale.nextAttemptAt).toBeNull();
    expect(live.status).toBe('PROCESSING');
    expect(exit.status).toBe('PROCESSING');
  });
});
