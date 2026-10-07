import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MovementsService } from './movements.service';

function harness() {
  const movements: any[] = [];
  const wine: any = { id: 'w1', caveId: 'c1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
  wine.updateMany = jest.fn(async ({ data }: any) => Object.assign(wine, data));
  const stock = () => movements.filter((m) => m.wineId === 'w1').reduce((s, m) => s + m.delta, 0);
  const prisma: any = {
    movement: {
      findUnique: async ({ where, include }: any) => {
        const m = movements.find((x) => x.idempotencyKey === where.idempotencyKey || x.id === where.id) ?? null;
        return m && include?.wine ? { ...m, wine } : m;
      },
      create: async ({ data, include }: any) => {
        if (stock() + data.delta < 0) throw new Error('il ne reste aucune bouteille de ce vin');
        const m = { id: `m${movements.length + 1}`, occurredAt: new Date(), ...data };
        movements.push(m);
        return include?.wine ? { ...m, wine } : m;
      },
      findMany: async ({ take }: any) => [...movements].reverse().slice(0, take).map((m) => ({ ...m, wine })),
      findFirst: async ({ where, include }: any) => {
        if (where.id !== undefined) {
          const byId = movements.find((x) => x.id === where.id && x.wineId === wine.id && where.wine?.caveId === wine.caveId) ?? null;
          return byId && include?.wine ? { ...byId, wine } : byId;
        }
        const m =
          movements.find((x) =>
            where.reversesId !== undefined ? x.reversesId === where.reversesId : x.photoId === where.photoId && x.type === where.type,
          ) ?? null;
        return m && include?.wine ? { ...m, wine } : m;
      },
    },
    wine: {
      findFirst: async ({ where }: any) => (where.id === wine.id && where.caveId === wine.caveId ? wine : null),
      updateMany: wine.updateMany,
    },
    photo: { findFirst: async () => ({ status: 'DONE' }) },
    $transaction: async (fn: any) => fn(prisma),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('?').includes('FOR UPDATE') ? (values[0] === wine.id ? [{ id: wine.id }] : []) : [{ quantity: stock() }],
  };
  const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
  return { movements, wine, prisma, service: new MovementsService(prisma as any, matching as any) };
}

describe('MovementsService — cave courante', () => {
  it('rapproche le vin dans la cave reçue', async () => {
    const h = harness();
    const matchOrCreate = jest.fn(async () => ({ wine: h.wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }));
    await new MovementsService(h.prisma, { matchOrCreate } as any).createIn('c1', input);
    expect(matchOrCreate).toHaveBeenCalledWith('c1', input.wine);
  });

  it('ne rejoue jamais la clé d’un mouvement d’une autre cave', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    await expect(h.service.createIn('c2', input)).rejects.toThrow(new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement'));
    await expect(h.service.cancel('c2', 'm1', input.idempotencyKey)).rejects.toBeInstanceOf(ConflictException);
  });

  it('traite un vin, un mouvement ou une photo d’une autre cave comme inconnus (404)', async () => {
    const h = harness();
    const r = await h.service.createIn('c1', input);
    await expect(h.service.createOut('c2', { idempotencyKey: 'o9', wineId: 'w1', quantity: 1 })).rejects.toThrow(new NotFoundException('Vin introuvable'));
    await expect(h.service.adjustTo('c2', 'w1', { idempotencyKey: 'i9', counted: 1 })).rejects.toThrow(new NotFoundException('Vin introuvable'));
    await expect(h.service.cancel('c2', r.movement.id, 'x9')).rejects.toThrow(new NotFoundException('Mouvement introuvable'));
    h.prisma.photo.findFirst = async () => null;
    await expect(h.service.createIn('c1', { ...input, idempotencyKey: 'k9', photoId: 'p-b' })).rejects.toThrow(new NotFoundException('Photo introuvable'));
    expect(h.movements).toHaveLength(1);
  });

  it('le journal ne lit que les mouvements des vins de la cave', async () => {
    const h = harness();
    const findMany = jest.fn(async () => []);
    h.prisma.movement.findMany = findMany;
    await h.service.recent('c1', 5);
    expect(findMany).toHaveBeenCalledWith({ where: { wine: { caveId: 'c1' } }, take: 5, orderBy: { occurredAt: 'desc' }, include: { wine: true } });
  });
});

const input = {
  idempotencyKey: 'k1',
  wine: { producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE' as const, formatCl: 75, vintage: 2019 },
  quantity: 6,
};

describe('MovementsService — fiche confirmée (mesure zéro saisie)', () => {
  it('garde la fiche confirmée d’une entrée par photo, et si la lecture était affichée', async () => {
    const h = harness();
    h.prisma.photo = { findFirst: async () => ({ status: 'DONE' }) };
    await h.service.createIn('c1', { ...input, photoId: 'ph1' });
    expect(h.movements[0].confirmedWine).toEqual({ ...input.wine, readingShown: true });
  });

  it('note qu’une entrée confirmée avant la fin de l’analyse n’a vu aucune lecture', async () => {
    const h = harness();
    h.prisma.photo = { findFirst: async () => ({ status: 'PROCESSING' }) };
    await h.service.createIn('c1', { ...input, photoId: 'ph1' });
    expect(h.movements[0].confirmedWine.readingShown).toBe(false);
  });

  it('ne garde rien pour une entrée sans photo', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    expect(h.movements[0].confirmedWine).toBeUndefined();
  });
});

describe('MovementsService', () => {
  it('creates a positive IN movement and returns the new stock', async () => {
    const h = harness();
    const r = await h.service.createIn('c1', input);
    expect(r.created).toBe(true);
    expect(r.movement.delta).toBe(6);
    expect(r.movement.type).toBe('IN');
    expect(r.stock).toBe(6);
  });

  it('is idempotent on idempotencyKey', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    const again = await h.service.createIn('c1', { ...input, quantity: 99 });
    expect(again.created).toBe(false);
    expect(h.movements).toHaveLength(1);
    expect((again.movement as unknown as { wine?: unknown }).wine).toBeUndefined();
  });

  it('is idempotent even when a concurrent replay wins the create race on idempotencyKey', async () => {
    // findUnique's pre-check misses (no row yet), then create() loses the race to a
    // concurrent request that inserted the same idempotencyKey first: Postgres throws
    // P2002 instead of returning cleanly. The service must recover by re-reading the
    // now-visible row, not bubble up a 500.
    const wine = { id: 'w1', caveId: 'c1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const racedMovement = {
      id: 'raced-1',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k1',
      reversesId: null,
    };
    let findUniqueCalls = 0;
    let createCalls = 0;
    const prisma = {
      movement: {
        findUnique: async () => {
          findUniqueCalls += 1;
          if (findUniqueCalls === 1) return null;
          return { ...racedMovement, wine };
        },
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['idempotency_key'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 6 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    const r = await service.createIn('c1', input);
    expect(r.created).toBe(false);
    expect(r.movement.id).toBe('raced-1');
    expect(createCalls).toBe(1);
    expect(findUniqueCalls).toBe(2);
  });

  it('returns the first movement when the same photo is confirmed twice', async () => {
    // idx_movement_photo_in : une photo ne crédite le stock qu'une fois. La seconde
    // confirmation (autre téléphone, ou retour sur une fiche déjà validée) porte une
    // idempotencyKey neuve, c'est donc l'index sur photo_id qui la rattrape.
    const wine = { id: 'w1', caveId: 'c1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const firstMovement = {
      id: 'm-first',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: 'ph1',
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k-first',
      reversesId: null,
    };
    let createCalls = 0;
    const findFirstArgs: any[] = [];
    const prisma = {
      photo: { findFirst: async () => ({ status: 'DONE' }) },
      movement: {
        findUnique: async () => null,
        findFirst: async (args: any) => {
          findFirstArgs.push(args);
          return { ...firstMovement, wine };
        },
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['photo_id'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 6 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    const r = await service.createIn('c1', { ...input, idempotencyKey: 'k-second', photoId: 'ph1' });
    expect(r.created).toBe(false);
    expect(r.movement.id).toBe('m-first');
    expect(r.stock).toBe(6);
    expect(createCalls).toBe(1);
    expect(findFirstArgs[0].where).toEqual({ photoId: 'ph1', type: 'IN' });
    expect((r.movement as unknown as { wine?: unknown }).wine).toBeUndefined();
  });

  it('rejects a non-positive quantity', async () => {
    const h = harness();
    await expect(h.service.createIn('c1', { ...input, quantity: 0 })).rejects.toThrow(/quantité/i);
  });

  it('cancels by writing the inverse movement, never deleting', async () => {
    const h = harness();
    const r = await h.service.createIn('c1', input);
    const c = await h.service.cancel('c1', r.movement.id, 'cancel-1');
    expect(c.movement.delta).toBe(-6);
    expect(c.movement.type).toBe('ADJUST');
    expect(c.movement.reversesId).toBe(r.movement.id);
    expect(c.stock).toBe(0);
    expect(h.movements).toHaveLength(2);
  });

  it('refuses to cancel twice', async () => {
    const h = harness();
    const r = await h.service.createIn('c1', input);
    await h.service.cancel('c1', r.movement.id, 'cancel-1');
    await expect(h.service.cancel('c1', r.movement.id, 'cancel-2')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to cancel a cancellation', async () => {
    const h = harness();
    const r = await h.service.createIn('c1', input);
    const c = await h.service.cancel('c1', r.movement.id, 'cancel-1');
    await expect(h.service.cancel('c1', c.movement.id, 'cancel-2')).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.cancel('c1', c.movement.id, 'cancel-3')).rejects.toThrow(/annulation ne peut pas être annulée/i);
  });

  it('is idempotent on cancel even when a concurrent replay wins the create race on idempotencyKey', async () => {
    const wine = { id: 'w1', caveId: 'c1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const original = {
      id: 'm1',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k1',
      reversesId: null,
    };
    const racedReversal = {
      id: 'raced-2',
      wineId: 'w1',
      delta: -6,
      type: 'ADJUST',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: 'Annulation du mouvement m1',
      idempotencyKey: 'cancel-1',
      reversesId: 'm1',
    };
    let idempotencyLookups = 0;
    let createCalls = 0;
    const prisma = {
      movement: {
        findUnique: async () => {
          // idempotencyKey lookup: miss on the pre-check, hit once the racing create has landed
          idempotencyLookups += 1;
          if (idempotencyLookups === 1) return null;
          return { ...racedReversal, wine };
        },
        findFirst: async ({ where }: any) => (where.id === 'm1' && where.wine?.caveId === 'c1' ? { ...original, wine } : null),
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['idempotency_key'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 0 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    const r = await service.cancel('c1', 'm1', 'cancel-1');
    expect(r.created).toBe(false);
    expect(r.movement.id).toBe('raced-2');
    expect(createCalls).toBe(1);
  });

  it('maps a concurrent double-cancel (racing on reversesId) to a 409, not a 500', async () => {
    const wine = { id: 'w1', caveId: 'c1', producer: 'Domaine Test', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75, vintage: 2019 };
    const original = {
      id: 'm1',
      wineId: 'w1',
      delta: 6,
      type: 'IN',
      occurredAt: new Date(),
      photoId: null,
      priceUnitCents: null,
      note: null,
      idempotencyKey: 'k1',
      reversesId: null,
    };
    const prisma = {
      movement: {
        findUnique: async () => null,
        // both racing requests pass the pre-check: neither has inserted its reversal yet
        findFirst: async ({ where }: any) => (where.id === 'm1' && where.wine?.caveId === 'c1' ? { ...original, wine } : null),
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['reverses_id'] },
          });
        },
      },
      $queryRaw: async () => [{ quantity: 6 }],
    };
    const matching = { matchOrCreate: async () => ({ wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const service = new MovementsService(prisma as any, matching as any);

    await expect(service.cancel('c1', 'm1', 'cancel-2')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.cancel('c1', 'm1', 'cancel-3')).rejects.toThrow(/déjà été annulé/);
  });
});

describe('MovementsService.createOut', () => {
  const out = { idempotencyKey: 'o1', wineId: 'w1', quantity: 1 };

  it('écrit une sortie négative et renvoie le stock restant', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    const r = await h.service.createOut('c1', out);
    expect(r.movement.type).toBe('OUT');
    expect(r.movement.delta).toBe(-1);
    expect(r.stock).toBe(5);
    expect(r.created).toBe(true);
  });

  it('est idempotente sur la clé', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    await h.service.createOut('c1', out);
    const again = await h.service.createOut('c1', { ...out, quantity: 3 });
    expect(again.created).toBe(false);
    expect(again.stock).toBe(5);
  });

  it('refuse en 409 lisible une sortie supérieure au stock', async () => {
    const h = harness();
    await h.service.createIn('c1', { ...input, quantity: 2 });
    await expect(h.service.createOut('c1', { ...out, quantity: 3 })).rejects.toThrow(new ConflictException('Il n’en reste que 2'));
  });

  it('renvoie la première sortie quand la même photo sert une seconde fois, sans redébiter', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    const first = await h.service.createOut('c1', { ...out, photoId: 'p-exit' });
    const second = await h.service.createOut('c1', { ...out, idempotencyKey: 'o2', photoId: 'p-exit' });
    expect(second.created).toBe(false);
    expect(second.movement.id).toBe(first.movement.id);
    expect(second.stock).toBe(5);
  });

  it('refuse en 409 une photo qui a déjà servi à sortir un autre vin, sans débiter', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    h.movements.push({ id: 'm-autre', wineId: 'w2', delta: -1, type: 'OUT', occurredAt: new Date(), photoId: 'p-exit', idempotencyKey: 'o-autre', reversesId: null });
    await expect(h.service.createOut('c1', { ...out, idempotencyKey: 'o2', photoId: 'p-exit' })).rejects.toThrow(
      new ConflictException('Cette photo a déjà servi à sortir un autre vin — annulez d’abord cette sortie'),
    );
    expect(h.movements.filter((m) => m.wineId === 'w1' && m.type === 'OUT')).toHaveLength(0);
  });

  it('écrit une nouvelle sortie, sans photo, quand la sortie de cette photo a été annulée (même vin)', async () => {
    const h = harness();
    await h.service.createIn('c1', input); // stock 6
    const first = await h.service.createOut('c1', { ...out, photoId: 'p-exit' }); // 5
    await h.service.cancel('c1', first.movement.id, 'c1'); // 6
    const again = await h.service.createOut('c1', { ...out, idempotencyKey: 'o2', photoId: 'p-exit' });
    expect(again.created).toBe(true);
    expect(again.movement.id).not.toBe(first.movement.id);
    expect(again.movement.photoId).toBeNull();
    expect(again.stock).toBe(5);
  });

  it('écrit une nouvelle sortie quand la photo avait servi à un autre vin puis été annulée', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    h.movements.push({ id: 'm-autre', wineId: 'w2', delta: -1, type: 'OUT', occurredAt: new Date(), photoId: 'p-exit', idempotencyKey: 'o-autre', reversesId: null });
    h.movements.push({ id: 'm-annul', wineId: 'w2', delta: 1, type: 'ADJUST', occurredAt: new Date(), photoId: null, idempotencyKey: 'c-autre', reversesId: 'm-autre' });
    const r = await h.service.createOut('c1', { ...out, idempotencyKey: 'o2', photoId: 'p-exit' });
    expect(r.created).toBe(true);
    expect(r.movement).toMatchObject({ wineId: 'w1', type: 'OUT', delta: -1, photoId: null });
    expect(r.stock).toBe(5);
    // Un double tap sur cette nouvelle sortie (même clé) la rejoue sans redébiter.
    const replay = await h.service.createOut('c1', { ...out, idempotencyKey: 'o2', photoId: 'p-exit' });
    expect(replay.created).toBe(false);
    expect(replay.stock).toBe(5);
  });

  it('refuse une quantité nulle ou négative', async () => {
    const h = harness();
    await expect(h.service.createOut('c1', { ...out, quantity: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('répond 404 pour un vin inconnu', async () => {
    const h = harness();
    await expect(h.service.createOut('c1', { ...out, wineId: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MovementsService.adjustTo', () => {
  it('écrit l’écart d’inventaire comme un ADJUST daté', async () => {
    const h = harness();
    await h.service.createIn('c1', input); // stock 6
    const r = await h.service.adjustTo('c1', 'w1', { idempotencyKey: 'inv1', counted: 4 });
    expect(r).toMatchObject({ delta: -2, stock: 4, created: true });
    expect(r.movement).toMatchObject({ type: 'ADJUST', delta: -2, note: 'Inventaire : 4 comptées' });
  });

  it('n’écrit rien quand le stock est déjà juste', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    const r = await h.service.adjustTo('c1', 'w1', { idempotencyKey: 'inv2', counted: 6 });
    expect(r).toEqual({ movement: null, stock: 6, delta: 0, created: false });
    expect(h.movements).toHaveLength(1);
  });

  it('accepte un inventaire supérieur au stock théorique', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    expect((await h.service.adjustTo('c1', 'w1', { idempotencyKey: 'inv3', counted: 8 })).delta).toBe(2);
  });

  it('est idempotent sur la clé', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    await h.service.adjustTo('c1', 'w1', { idempotencyKey: 'inv4', counted: 4 });
    const again = await h.service.adjustTo('c1', 'w1', { idempotencyKey: 'inv4', counted: 4 });
    expect(again.created).toBe(false);
    expect(h.movements).toHaveLength(2);
  });

  it('répond 404 pour un vin inconnu', async () => {
    const h = harness();
    await expect(h.service.adjustTo('c1', 'nope', { idempotencyKey: 'inv5', counted: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MovementsService.createIn — photo de référence', () => {
  it('retient la photo de la première entrée comme photo de référence du vin', async () => {
    const h = harness();
    await h.service.createIn('c1', { ...input, photoId: 'p-in' });
    expect(h.wine.updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', referencePhotoId: null },
      data: { referencePhotoId: 'p-in' },
    });
  });

  it('ne remplace pas une photo de référence déjà posée', async () => {
    const h = harness();
    (h.wine as any).referencePhotoId = 'p-old';
    await h.service.createIn('c1', { ...input, photoId: 'p-in' });
    expect(h.wine.updateMany).not.toHaveBeenCalled();
  });
});

describe('MovementsService.createOut — clé d’idempotence déjà prise par un autre mouvement', () => {
  const out = { idempotencyKey: 'shared', wineId: 'w1', quantity: 1 };

  it('refuse une clé déjà utilisée par une entrée', async () => {
    const h = harness();
    await h.service.createIn('c1', { ...input, idempotencyKey: 'shared' });
    await expect(h.service.createOut('c1', out)).rejects.toThrow(
      new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement'),
    );
  });

  it('refuse une clé déjà utilisée par la sortie d’un autre vin', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    h.movements.push({
      id: 'm-other',
      wineId: 'w2',
      delta: -1,
      type: 'OUT',
      occurredAt: new Date(),
      photoId: null,
      idempotencyKey: 'shared',
      reversesId: null,
    });
    await expect(h.service.createOut('c1', out)).rejects.toThrow(
      new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement'),
    );
  });
});

describe('MovementsService.adjustTo — clé d’idempotence déjà prise par un autre mouvement', () => {
  it('refuse une clé déjà utilisée par une entrée', async () => {
    const h = harness();
    await h.service.createIn('c1', { ...input, idempotencyKey: 'shared' });
    await expect(h.service.adjustTo('c1', 'w1', { idempotencyKey: 'shared', counted: 1 })).rejects.toThrow(
      new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement'),
    );
  });

  it('refuse une clé déjà utilisée par l’inventaire d’un autre vin', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    h.movements.push({
      id: 'm-other',
      wineId: 'w2',
      delta: -2,
      type: 'ADJUST',
      occurredAt: new Date(),
      photoId: null,
      idempotencyKey: 'shared',
      reversesId: null,
    });
    await expect(h.service.adjustTo('c1', 'w1', { idempotencyKey: 'shared', counted: 1 })).rejects.toThrow(
      new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement'),
    );
  });
});

describe('MovementsService — accords à la création d’un vin', () => {
  it('met en file les accords d’un vin créé par l’entrée', async () => {
    const h = harness();
    const schedule = jest.fn(async () => undefined);
    const matching = { matchOrCreate: async () => ({ wine: h.wine, created: true, appellation: { kind: 'none', raw: 'Bandol' } }) };
    await new MovementsService(h.prisma, matching as any, { schedule } as any).createIn('c1', input);
    expect(schedule).toHaveBeenCalledWith('w1');
  });

  it('ne fait rien pour un vin déjà connu', async () => {
    const h = harness();
    const schedule = jest.fn(async () => undefined);
    const matching = { matchOrCreate: async () => ({ wine: h.wine, created: false, appellation: { kind: 'none', raw: 'Bandol' } }) };
    await new MovementsService(h.prisma, matching as any, { schedule } as any).createIn('c1', input);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('n’échoue jamais à cause de la file d’accords', async () => {
    const h = harness();
    const schedule = jest.fn(async () => { throw new Error('Redis injoignable'); });
    const matching = { matchOrCreate: async () => ({ wine: h.wine, created: true, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const r = await new MovementsService(h.prisma, matching as any, { schedule } as any).createIn('c1', input);
    expect(r.created).toBe(true);
  });

  it('n’attend jamais la file d’accords : une file bloquée (Redis injoignable) ne retient pas l’entrée', async () => {
    const h = harness();
    const schedule = jest.fn(() => new Promise<void>(() => undefined));
    const matching = { matchOrCreate: async () => ({ wine: h.wine, created: true, appellation: { kind: 'none', raw: 'Bandol' } }) };
    const r = await new MovementsService(h.prisma, matching as any, { schedule } as any).createIn('c1', input);
    expect(r.created).toBe(true);
    expect(schedule).toHaveBeenCalledWith('w1');
  });
});

describe('MovementsService — descriptif du domaine à la création d’un vin', () => {
  const created = (h: ReturnType<typeof harness>, wineCreated = true) => ({
    matchOrCreate: async () => ({ wine: h.wine, created: wineCreated, appellation: { kind: 'none', raw: 'Bandol' } }),
  });

  it('demande le descriptif du domaine d’un vin créé par l’entrée', async () => {
    const h = harness();
    const scheduleIfMissing = jest.fn(async () => undefined);
    await new MovementsService(h.prisma, created(h) as any, undefined, { scheduleIfMissing } as any).createIn('c1', input);
    expect(scheduleIfMissing).toHaveBeenCalledWith('Domaine Test');
  });

  it('ne fait rien pour un vin déjà connu', async () => {
    const h = harness();
    const scheduleIfMissing = jest.fn(async () => undefined);
    await new MovementsService(h.prisma, created(h, false) as any, undefined, { scheduleIfMissing } as any).createIn('c1', input);
    expect(scheduleIfMissing).not.toHaveBeenCalled();
  });

  it('n’échoue jamais et n’attend jamais la file des descriptifs', async () => {
    const h = harness();
    const failing = jest.fn(async () => { throw new Error('Redis injoignable'); });
    expect((await new MovementsService(h.prisma, created(h) as any, undefined, { scheduleIfMissing: failing } as any).createIn('c1', input)).created).toBe(true);
    const h2 = harness();
    const hanging = jest.fn(() => new Promise<void>(() => undefined));
    expect((await new MovementsService(h2.prisma, created(h2) as any, undefined, { scheduleIfMissing: hanging } as any).createIn('c1', input)).created).toBe(true);
    expect(hanging).toHaveBeenCalledWith('Domaine Test');
  });
});

describe('MovementsService — photo d’une image du web (REFERENCE)', () => {
  const reference = (h: ReturnType<typeof harness>) => {
    h.prisma.photo.findFirst = async () => ({ status: 'DONE', purpose: 'REFERENCE' });
  };

  it('refuse une entrée qui s’appuierait sur une image du web, sans rien écrire', async () => {
    const h = harness();
    reference(h);
    const e = await h.service.createIn('c1', { ...input, photoId: 'p-ref' }).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Photo invalide pour une entrée');
    expect(h.movements).toHaveLength(0);
    expect(h.wine.updateMany).not.toHaveBeenCalled();
  });

  it('refuse une sortie qui s’appuierait sur une image du web, sans débiter', async () => {
    const h = harness();
    await h.service.createIn('c1', input);
    reference(h);
    const e = await h.service.createOut('c1', { idempotencyKey: 'o-ref', wineId: 'w1', quantity: 1, photoId: 'p-ref' }).catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('Photo invalide pour une sortie');
    expect(h.movements).toHaveLength(1);
  });

  it('accepte toujours une photo d’entrée ou de sortie ordinaire', async () => {
    const h = harness();
    h.prisma.photo.findFirst = async () => ({ status: 'DONE', purpose: 'ENTRY' });
    await expect(h.service.createIn('c1', { ...input, photoId: 'p-in' })).resolves.toMatchObject({ created: true });
    h.prisma.photo.findFirst = async () => ({ status: 'DONE', purpose: 'EXIT' });
    await expect(h.service.createOut('c1', { idempotencyKey: 'o2', wineId: 'w1', quantity: 1, photoId: 'p-out' })).resolves.toMatchObject({ created: true });
  });
});
