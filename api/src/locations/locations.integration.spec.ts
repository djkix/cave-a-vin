import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Wine, WineColor } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApogeeRulesService } from '../apogee/apogee-rules.service';
import { CaveService } from '../cave/cave.service';
import { MovementsService } from '../movements/movements.service';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';
import { LocationsService } from './locations.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('emplacements (base réelle)', () => {
  const prisma = new PrismaClient();
  const locations = new LocationsService(prisma as never);
  let caveId: string;
  let otherCaveId: string;
  let current: Wine;
  // Rapprochement simulé : l'entrée crédite le vin courant de la cave.
  const matching = { matchOrCreate: async () => ({ wine: current, created: false }) };
  const movements = new MovementsService(prisma as never, matching as never, locations);
  const cave = new CaveService(prisma as never, new ApogeeRulesService(prisma as never), locations);
  const draft = { producer: 'Domaine Rangé', appellationRaw: 'Bandol', color: 'ROUGE' as const, formatCl: 75 };

  beforeAll(async () => {
    caveId = (await createTestCave(prisma)).id;
    otherCaveId = (await createTestCave(prisma)).id;
  });

  afterAll(async () => {
    await deleteTestCaves(prisma, [caveId, otherCaveId]);
    await prisma.$disconnect();
  });

  async function newWine(name = randomUUID()): Promise<Wine> {
    current = await prisma.wine.create({ data: { caveId, matchKey: `loc-${name}`, producer: `Domaine Rangé ${name}`, appellationRaw: 'Bandol', color: WineColor.ROUGE } });
    return current;
  }
  const entry = (quantity: number, location?: { zone?: string; casier?: string; position?: string } | null) =>
    movements.createIn(caveId, { idempotencyKey: randomUUID(), wine: draft, quantity, location });
  const out = (wineId: string, quantity: number, locationId?: string | null) =>
    movements.createOut(caveId, { idempotencyKey: randomUUID(), wineId, quantity, ...(locationId !== undefined ? { locationId } : {}) });
  const places = (wineId: string) => locations.stockByLocation(caveId, wineId);
  const idOf = async (zone: string, casier?: string) => (await locations.resolve(caveId, { zone, casier })).id;

  describe('normalisation et unicité', () => {
    it('le même emplacement saisi autrement est la même ligne, propre à la cave', async () => {
      const a = await locations.resolve(caveId, { zone: ' Cave 2 ', casier: 'B', position: '3' });
      const b = await locations.resolve(caveId, { zone: 'cave 2', casier: ' b', position: '3 ' });
      expect(b.id).toBe(a.id);
      expect(a).toMatchObject({ zone: 'Cave 2', casier: 'B', position: '3', labelKey: 'cave 2|b|3' });
      const other = await locations.resolve(otherCaveId, { zone: 'Cave 2', casier: 'B', position: '3' });
      expect(other.id).not.toBe(a.id);
      const [x, y] = await Promise.all([locations.resolve(caveId, { zone: 'Course' }), locations.resolve(caveId, { zone: 'course' })]);
      expect(x.id).toBe(y.id);
    });

    it('liste les emplacements de la cave seulement, par libellé', async () => {
      await locations.resolve(caveId, { zone: 'Armoire' });
      const list = await locations.list(caveId);
      expect(list.map((l) => l.label)).toEqual([...list.map((l) => l.label)].sort((a, b) => a.localeCompare(b, 'fr')));
      expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3' })]));
      expect((await locations.list(otherCaveId)).map((l) => l.label)).toEqual(['Cave 2 / B / 3']);
    });

    it('rejette un emplacement vide ou trop long, sans rien écrire', async () => {
      const w = await newWine();
      await expect(entry(1, { zone: '  ' })).rejects.toThrow(new BadRequestException('Indiquez au moins une zone, un casier ou une position'));
      await expect(entry(1, { casier: 'x'.repeat(41) })).rejects.toThrow(new BadRequestException('40 caractères au plus par champ d\'emplacement'));
      expect(await prisma.movement.count({ where: { wineId: w.id } })).toBe(0);
    });
  });

  describe('stock par emplacement', () => {
    it('entrée, sortie, inventaire et « Sans emplacement »', async () => {
      const w = await newWine();
      await entry(4, { zone: 'Cave 2', casier: 'B', position: '3' });
      await entry(3);
      const b3 = (await locations.resolve(caveId, { zone: 'Cave 2', casier: 'B', position: '3' })).id;
      expect(await places(w.id)).toEqual([
        { id: b3, label: 'Cave 2 / B / 3', quantity: 4 },
        { id: null, label: 'Sans emplacement', quantity: 3 },
      ]);

      await out(w.id, 1, b3);
      await out(w.id, 1, null);
      expect((await places(w.id)).map((p) => p.quantity)).toEqual([3, 2]);

      // Inventaire : une baisse à l'endroit choisi, une hausse par défaut « Sans emplacement ».
      await movements.adjustTo(caveId, w.id, { idempotencyKey: randomUUID(), counted: 4, locationId: b3 });
      expect((await places(w.id)).map((p) => p.quantity)).toEqual([2, 2]);
      await movements.adjustTo(caveId, w.id, { idempotencyKey: randomUUID(), counted: 6 });
      expect((await places(w.id)).map((p) => p.quantity)).toEqual([2, 4]);
      await movements.adjustTo(caveId, w.id, { idempotencyKey: randomUUID(), counted: 7, locationId: b3 });
      expect(await places(w.id)).toEqual([
        { id: b3, label: 'Cave 2 / B / 3', quantity: 3 },
        { id: null, label: 'Sans emplacement', quantity: 4 },
      ]);
    });

    it('409 « Pas assez de bouteilles à cet emplacement », rien d’écrit', async () => {
      const w = await newWine();
      await entry(1, { zone: 'Haut' });
      await entry(5);
      const haut = await idOf('Haut');
      const count = await prisma.movement.count({ where: { wineId: w.id } });
      await expect(out(w.id, 2, haut)).rejects.toThrow(new ConflictException('Pas assez de bouteilles à cet emplacement'));
      await expect(movements.adjustTo(caveId, w.id, { idempotencyKey: randomUUID(), counted: 3, locationId: haut })).rejects.toThrow(
        new ConflictException('Pas assez de bouteilles à cet emplacement'),
      );
      // Le total insuffisant garde son message habituel.
      await expect(out(w.id, 9, null)).rejects.toThrow(new ConflictException('Il n’en reste que 6'));
      expect(await prisma.movement.count({ where: { wineId: w.id } })).toBe(count);
    });

    it('sortie sans champ locationId (ancien client) : « Sans emplacement » d’abord, sinon la pré-sélection', async () => {
      const w = await newWine();
      await entry(1);
      await entry(2, { zone: 'Bas' });
      const bas = await idOf('Bas');
      expect((await out(w.id, 1)).movement.locationId).toBeNull();
      expect((await out(w.id, 1)).movement.locationId).toBe(bas);
      expect(await places(w.id)).toEqual([{ id: bas, label: 'Bas', quantity: 1 }]);
    });

    it('emplacement d’une autre cave : 404 « Emplacement introuvable »', async () => {
      const w = await newWine();
      await entry(2);
      const foreign = (await locations.resolve(otherCaveId, { zone: 'Ailleurs' })).id;
      const notFound = new NotFoundException('Emplacement introuvable');
      await expect(out(w.id, 1, foreign)).rejects.toThrow(notFound);
      await expect(movements.adjustTo(caveId, w.id, { idempotencyKey: randomUUID(), counted: 1, locationId: foreign })).rejects.toThrow(notFound);
      await expect(movements.move(caveId, w.id, { from: foreign, to: { zone: 'Ici' }, quantity: 1 })).rejects.toThrow(notFound);
      await expect(cave.list(caveId, { location: foreign })).rejects.toThrow(notFound);
      expect(await prisma.movement.count({ where: { wineId: w.id } })).toBe(1);
    });
  });

  describe('déplacement', () => {
    it('range, déplace, refuse l’identique et le manque, rejoue la même clé', async () => {
      const w = await newWine();
      await entry(5);
      const key = randomUUID();
      const r = await movements.move(caveId, w.id, { idempotencyKey: key, from: null, to: { zone: 'Cave 2', casier: 'C' }, quantity: 3 });
      const c = await idOf('Cave 2', 'C');
      expect(r.locations).toEqual([
        { id: c, label: 'Cave 2 / C', quantity: 3 },
        { id: null, label: 'Sans emplacement', quantity: 2 },
      ]);
      // Rejeu (double tap) : rien de plus.
      await movements.move(caveId, w.id, { idempotencyKey: key, from: null, to: { zone: 'Cave 2', casier: 'C' }, quantity: 3 });
      const pair = await prisma.movement.findMany({ where: { wineId: w.id, type: 'MOVE' }, orderBy: { delta: 'asc' } });
      expect(pair.map((m) => [m.delta, m.locationId])).toEqual([[-3, null], [3, c]]);
      expect(pair[0].occurredAt.getTime()).toBe(pair[1].occurredAt.getTime());
      expect(await movements.stockOf(w.id)).toBe(5);

      await expect(movements.move(caveId, w.id, { from: c, to: { zone: 'cave 2 ', casier: 'c' }, quantity: 1 })).rejects.toThrow(
        new BadRequestException('Emplacement d\'origine et de destination identiques'),
      );
      await expect(movements.move(caveId, w.id, { from: c, to: { zone: 'Cave 3' }, quantity: 4 })).rejects.toThrow(
        new ConflictException('Pas assez de bouteilles à cet emplacement'),
      );
      await expect(movements.move(caveId, w.id, { from: null, to: { zone: 'Cave 3' }, quantity: 3 })).rejects.toThrow(
        new ConflictException('Pas assez de bouteilles à cet emplacement'),
      );
      expect(await prisma.movement.count({ where: { wineId: w.id, type: 'MOVE' } })).toBe(2);

      const moved = await movements.move(caveId, w.id, { from: c, to: { zone: 'Cave 3' }, quantity: 3 });
      expect(moved.locations.map((p) => [p.label, p.quantity])).toEqual([['Cave 3', 3], ['Sans emplacement', 2]]);
    });

    it('annuler l’une ou l’autre moitié annule les deux', async () => {
      for (const half of [-1, 1]) {
        const w = await newWine();
        await entry(2);
        await movements.move(caveId, w.id, { from: null, to: { zone: 'Paire' }, quantity: 2 });
        const target = await prisma.movement.findFirstOrThrow({ where: { wineId: w.id, type: 'MOVE', delta: half * 2 } });
        const r = await movements.cancel(caveId, target.id, randomUUID());
        expect(r.movement.reversesId).toBe(target.id);
        expect(await places(w.id)).toEqual([{ id: null, label: 'Sans emplacement', quantity: 2 }]);
        expect(await prisma.movement.count({ where: { wineId: w.id, reversesId: { not: null } } })).toBe(2);
        const other = await prisma.movement.findFirstOrThrow({ where: { wineId: w.id, type: 'MOVE', delta: -half * 2 } });
        await expect(movements.cancel(caveId, other.id, randomUUID())).rejects.toThrow(new ConflictException('Ce mouvement a déjà été annulé'));
      }
    });

    it('une annulation rend la bouteille à son emplacement, et refuse si elle n’y est plus', async () => {
      const w = await newWine();
      const inA = await entry(2, { zone: 'Retour' });
      const retour = await idOf('Retour');
      const exit = await out(w.id, 1, retour);
      await movements.cancel(caveId, exit.movement.id, randomUUID());
      expect(await places(w.id)).toEqual([{ id: retour, label: 'Retour', quantity: 2 }]);
      const reversal = await prisma.movement.findFirstOrThrow({ where: { reversesId: exit.movement.id } });
      expect(reversal.locationId).toBe(retour);

      // Les bouteilles de l'entrée ont été déplacées : l'annuler viderait « Retour » sous zéro.
      await movements.move(caveId, w.id, { from: retour, to: { zone: 'Ailleurs' }, quantity: 2 });
      await expect(movements.cancel(caveId, inA.movement.id, randomUUID())).rejects.toThrow(new ConflictException('Pas assez de bouteilles à cet emplacement'));
    });
  });

  describe('correctifs de revue', () => {
    it('annuler un déplacement dont les bouteilles ont été bues : 409 par emplacement, pas le message du total', async () => {
      const w = await newWine();
      await entry(3);
      await movements.move(caveId, w.id, { from: null, to: { zone: 'Bues' }, quantity: 3 });
      const bues = await idOf('Bues');
      await out(w.id, 2, bues);
      const half = await prisma.movement.findFirstOrThrow({ where: { wineId: w.id, type: 'MOVE', delta: 3 } });
      const count = await prisma.movement.count({ where: { wineId: w.id } });
      await expect(movements.cancel(caveId, half.id, randomUUID())).rejects.toThrow(new ConflictException('Pas assez de bouteilles à cet emplacement'));
      expect(await prisma.movement.count({ where: { wineId: w.id } })).toBe(count);
    });

    it('rejouer l’annulation d’un déplacement rend la même annulation, sans troisième mouvement', async () => {
      const w = await newWine();
      await entry(2);
      await movements.move(caveId, w.id, { from: null, to: { zone: 'Rejeu' }, quantity: 2 });
      const half = await prisma.movement.findFirstOrThrow({ where: { wineId: w.id, type: 'MOVE', delta: -2 } });
      const key = randomUUID();
      const first = await movements.cancel(caveId, half.id, key);
      const again = await movements.cancel(caveId, half.id, key);
      expect(again.created).toBe(false);
      expect(again.movement.id).toBe(first.movement.id);
      expect(await prisma.movement.count({ where: { wineId: w.id, reversesId: { not: null } } })).toBe(2);
    });

    it('une clé déjà utilisée ne sert ni à un déplacement, ni (après un déplacement) à une entrée, une sortie ou un inventaire', async () => {
      const w = await newWine();
      const used = (await entry(3)).movement.idempotencyKey;
      const reused = new ConflictException('Clé d’idempotence déjà utilisée pour un autre mouvement');
      await expect(movements.move(caveId, w.id, { idempotencyKey: used, from: null, to: { zone: 'Clé' }, quantity: 1 })).rejects.toThrow(reused);
      const k = randomUUID();
      await movements.move(caveId, w.id, { idempotencyKey: k, from: null, to: { zone: 'Clé' }, quantity: 1 });
      const count = await prisma.movement.count({ where: { wineId: w.id } });
      await expect(movements.createIn(caveId, { idempotencyKey: k, wine: draft, quantity: 1 })).rejects.toThrow(reused);
      await expect(movements.createOut(caveId, { idempotencyKey: k, wineId: w.id, quantity: 1 })).rejects.toThrow(reused);
      await expect(movements.adjustTo(caveId, w.id, { idempotencyKey: k, counted: 1 })).rejects.toThrow(reused);
      expect(await prisma.movement.count({ where: { wineId: w.id } })).toBe(count);
    });

    it('deux sorties simultanées de la dernière bouteille d’un emplacement : une réussit, l’autre 409', async () => {
      const w = await newWine();
      await entry(1, { zone: 'Course sortie' });
      await entry(5);
      const loc = await idOf('Course sortie');
      const results = await Promise.allSettled([out(w.id, 1, loc), out(w.id, 1, loc)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect(rejected.reason).toEqual(new ConflictException('Pas assez de bouteilles à cet emplacement'));
      expect(await places(w.id)).toEqual([{ id: null, label: 'Sans emplacement', quantity: 5 }]);
      expect(await movements.stockOf(w.id)).toBe(5);
    });

    it('une sortie et un déplacement simultanés de la dernière bouteille d’un emplacement : un seul passe', async () => {
      const w = await newWine();
      await entry(1, { zone: 'Course départ' });
      await entry(5);
      const loc = await idOf('Course départ');
      const results = await Promise.allSettled([
        out(w.id, 1, loc),
        movements.move(caveId, w.id, { from: loc, to: { zone: 'Course arrivée' }, quantity: 1 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toEqual(
        new ConflictException('Pas assez de bouteilles à cet emplacement'),
      );
      const after = await places(w.id);
      expect(after.find((p) => p.id === loc)).toBeUndefined();
      expect(after.reduce((s, p) => s + p.quantity, 0)).toBe(await movements.stockOf(w.id));
      expect(await movements.stockOf(w.id)).toBe(results[0].status === 'fulfilled' ? 5 : 6);
    });
  });

  describe('pré-sélections', () => {
    it('exitDefault : le dernier endroit qui a reçu ce vin et en a encore', async () => {
      const w = await newWine();
      expect(await locations.exitDefault(caveId, w.id)).toBeUndefined();
      await entry(1);
      expect(await locations.exitDefault(caveId, w.id)).toBeNull();
      await entry(1, { zone: 'Récent' });
      const recent = await idOf('Récent');
      expect(await locations.exitDefault(caveId, w.id)).toBe(recent);
      await movements.move(caveId, w.id, { from: null, to: { zone: 'Déplacé' }, quantity: 1 });
      const moved = await idOf('Déplacé');
      expect(await locations.exitDefault(caveId, w.id)).toBe(moved);
      await out(w.id, 1, moved);
      expect(await locations.exitDefault(caveId, w.id)).toBe(recent);
    });

    it('lastInLocation : emplacement de la dernière entrée de la cave qui en a un', async () => {
      const fresh = (await createTestCave(prisma)).id;
      try {
        expect(await locations.lastInLocation(fresh)).toBeNull();
        await newWine();
        await entry(1, { zone: 'Dernier', position: '7' });
        await entry(1);
        expect(await locations.lastInLocation(caveId)).toEqual({ zone: 'Dernier', casier: null, position: '7' });
      } finally {
        await deleteTestCaves(prisma, [fresh]);
      }
    });
  });

  describe('fiche et journal', () => {
    it('la fiche porte locations, exitDefault et lastLocation, pour le membre comme pour le propriétaire', async () => {
      const w = await newWine();
      await entry(2, { zone: 'Fiche', casier: 'A' });
      await entry(1);
      await movements.move(caveId, w.id, { from: null, to: { zone: 'Fiche', casier: 'B' }, quantity: 1 });
      const a = await idOf('Fiche', 'A');
      const b = await idOf('Fiche', 'B');
      for (const role of ['OWNER', 'VIEWER'] as const) {
        const d = await cave.detail(caveId, w.id, role);
        expect(d.locations).toEqual([
          { id: a, label: 'Fiche / A', quantity: 2 },
          { id: b, label: 'Fiche / B', quantity: 1 },
        ]);
        expect(d.exitDefault).toBe(b);
        expect(d.lastLocation).toEqual({ zone: 'Fiche', casier: 'A', position: null });
        expect(d.movements.filter((m) => m.type === 'MOVE').map((m) => [m.delta, m.locationLabel]).sort()).toEqual([[-1, null], [1, 'Fiche / B']]);
      }
      const journal = await movements.recent(caveId, 100);
      expect(journal.find((m) => m.wineId === w.id && m.type === 'MOVE' && m.delta === 1)?.locationLabel).toBe('Fiche / B');
      expect(journal.every((m) => !('location' in m))).toBe(true);
    });
  });

  describe('filtre de la cave', () => {
    it('?location=<id> et ?location=none : vins avec du stock à cet endroit', async () => {
      const placed = await newWine();
      await entry(2, { zone: 'Filtre' });
      const loose = await newWine();
      await entry(1);
      const filtre = await idOf('Filtre');
      const both = await newWine();
      await entry(1, { zone: 'Filtre' });
      await entry(1);
      const ids = async (location: string) => (await cave.list(caveId, { location })).map((i) => i.id);
      expect(await ids(filtre)).toEqual(expect.arrayContaining([placed.id, both.id]));
      expect(await ids(filtre)).not.toContain(loose.id);
      expect(await ids('none')).toEqual(expect.arrayContaining([loose.id, both.id]));
      expect(await ids('none')).not.toContain(placed.id);
      await out(placed.id, 2, filtre);
      expect(await ids(filtre)).not.toContain(placed.id);
    });
  });
});
