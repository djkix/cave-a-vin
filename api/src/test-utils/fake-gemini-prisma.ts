/* eslint-disable @typescript-eslint/no-explicit-any */
/** Faux Prisma : `app_setting` en mémoire, `gemini_call` en tableau, transaction exécutée sur le même objet. */
export function fakeGeminiPrisma() {
  const settings = new Map<string, string>();
  const calls: Array<Record<string, unknown>> = [];
  const prisma: any = {
    settings,
    calls,
    appSetting: {
      findMany: jest.fn(async ({ where }: any) =>
        [...settings.entries()].filter(([key]) => where.key.in.includes(key)).map(([key, value]) => ({ key, value })),
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        if (settings.has(where.key)) {
          if (update.value !== undefined) settings.set(where.key, update.value);
        } else settings.set(where.key, create.value);
        return { key: where.key, value: settings.get(where.key) };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        settings.set(where.key, data.value);
        return { key: where.key, value: data.value };
      }),
    },
    geminiCall: { create: jest.fn(async ({ data }: any) => (calls.push(data), data)) },
    // Création sans conflit (INSERT … ON CONFLICT DO NOTHING) : le premier paramètre est la clé.
    $executeRaw: jest.fn(async (_s: TemplateStringsArray, key: string) => {
      if (settings.has(key)) return 0;
      settings.set(key, '');
      return 1;
    }),
    // Verrou de la ligne (SELECT … FOR UPDATE) : le faux rend simplement la valeur courante.
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, key: string) =>
      settings.has(key) ? [{ value: settings.get(key) }] : [],
    ),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return prisma;
}

