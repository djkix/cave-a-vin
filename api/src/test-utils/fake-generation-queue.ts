/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Faux Prisma pour les lots d'accords et de descriptifs : une table en mémoire
 * (`pairing` ou `producerProfile`) qui interprète le sous-ensemble de `where`
 * et `data` qu'utilise GenerationBatchProcessor. La réservation SQL
 * (`$queryRaw`) est simulée avec l'horloge du test (`clock.now`).
 */
export interface QueueRow {
  id: string;
  status: string;
  requestedAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  reservedUntil: Date | null;
  errorMessage: string | null;
  source?: string;
  wineId?: string;
  producerKey?: string;
  [field: string]: unknown;
}

export function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      if ('in' in cond) return cond.in.includes(value);
      if ('lte' in cond) return value instanceof Date && value.getTime() <= cond.lte.getTime();
      if ('gte' in cond) return value >= cond.gte;
      if ('lt' in cond) return value < cond.lt;
      throw new Error(`condition non gérée par le faux : ${JSON.stringify(cond)}`);
    }
    return value === cond;
  });
}

function apply(row: any, data: any) {
  for (const [k, v] of Object.entries(data)) {
    row[k] = v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && 'increment' in (v as any) ? (row[k] ?? 0) + (v as any).increment : v;
  }
}

export function fakeGenerationQueue(
  tableKey: 'pairing' | 'producerProfile',
  opts: { wines?: Record<string, unknown>; producerWines?: unknown[] } = {},
) {
  const rows: QueueRow[] = [];
  const clock = { now: new Date() };
  const sorted = (list: QueueRow[]) => [...list].sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  const table = {
    findMany: jest.fn(async ({ where, take, select }: any) => {
      const hit = sorted(rows.filter((r) => matches(r, where))).slice(0, take ?? Infinity);
      if (select?.requestedAt) return hit.map((r) => ({ requestedAt: r.requestedAt }));
      if (select?.wine) return hit.map((r) => ({ id: r.id, wine: opts.wines?.[r.wineId!] }));
      return hit.map((r) => ({ id: r.id, producerKey: r.producerKey }));
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => apply(r, data));
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { count: hit.length };
    }),
  };
  const ready = (r: QueueRow) =>
    r.status === 'PENDING' &&
    r.reservedUntil === null &&
    r.requestedAt.getTime() <= clock.now.getTime() &&
    (r.nextAttemptAt === null || r.nextAttemptAt.getTime() <= clock.now.getTime()) &&
    (tableKey === 'pairing' || r.source === 'GEMINI');
  const prisma: any = {
    [tableKey]: table,
    wine: { findMany: jest.fn(async () => opts.producerWines ?? []) },
    $queryRaw: jest.fn(async () => sorted(rows.filter(ready)).slice(0, 10).map((r) => ({ id: r.id, attempts: r.attempts }))),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  function add(row: Partial<QueueRow> & { id: string }): QueueRow {
    const full: QueueRow = {
      status: 'PENDING',
      requestedAt: new Date(clock.now.getTime() - 3 * 60_000),
      attempts: 0,
      nextAttemptAt: null,
      reservedUntil: null,
      errorMessage: null,
      ...(tableKey === 'producerProfile' ? { source: 'GEMINI' } : {}),
      ...row,
    };
    rows.push(full);
    return full;
  }

  return { prisma, table, rows, clock, add, row: (id: string) => rows.find((r) => r.id === id)! };
}
