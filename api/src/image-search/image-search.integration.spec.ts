import { GoneException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ImageNormalizationService } from '../photos/image-normalization.service';
import { PhotosService } from '../photos/photos.service';
import { createTestCave, deleteTestCaves } from '../test-utils/cave';
import { CandidateStore } from './candidates';
import { ImageSearchService } from './image-search.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const key = (p: string) => `${p}-${Date.now()}-${Math.random()}`;

describeIfDb('image du web — choix, retour, exclusion des listes (base réelle)', () => {
  const prisma = new PrismaClient();
  const dir = mkdtempSync(join(tmpdir(), 'cave-reference-'));
  const wineIds: string[] = [];
  const photoIds: string[] = [];
  const movementIds: string[] = [];
  let jpeg: Buffer;
  let caveId: string;
  let otherCaveId: string;
  const fetcher = jest.fn(async (url: string) => ({ buffer: jpeg, contentType: 'image/jpeg', finalUrl: url }));
  const store = new CandidateStore(dir, fetcher);
  const service = new ImageSearchService(prisma as never, store, {} as never, {} as never, dir, fetcher, { currentPause: async () => null } as never);

  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 300, height: 450, channels: 3, background: '#5b1a26' } }).jpeg().toBuffer();
    caveId = (await createTestCave(prisma)).id;
    otherCaveId = (await createTestCave(prisma)).id;
  });

  afterAll(async () => {
    const wines = await prisma.wine.findMany({ where: { id: { in: wineIds } }, select: { referencePhotoId: true } });
    await prisma.movement.deleteMany({ where: { id: { in: movementIds } } });
    await prisma.wine.deleteMany({ where: { id: { in: wineIds } } });
    await prisma.photo.deleteMany({ where: { id: { in: [...photoIds, ...wines.map((w) => w.referencePhotoId!).filter(Boolean)] } } });
    await deleteTestCaves(prisma, [caveId, otherCaveId]);
    await prisma.$disconnect();
  });

  async function wine(referencePhotoId: string | null = null) {
    const w = await prisma.wine.create({
      data: { caveId, matchKey: key('ref'), producer: 'Domaine Tempier', appellationRaw: 'Bandol', color: 'ROUGE', referencePhotoId },
    });
    wineIds.push(w.id);
    return w;
  }

  async function entryPhoto() {
    const p = await prisma.photo.create({ data: { caveId, contentHash: key('own'), storagePath: 'normalized/own.jpg', status: 'DONE', purpose: 'ENTRY' } });
    photoIds.push(p.id);
    return p;
  }

  async function candidate(wineId: string, source = 'Open Food Facts (CC BY-SA)', sourceUrl = 'https://world.openfoodfacts.org/product/1') {
    return (await store.add({ imageUrl: 'https://images.exemple/x.jpg', source, sourceUrl }, wineId))!;
  }

  it('la candidate devient une photo REFERENCE DONE et la vignette ; l’ancienne vignette est mémorisée', async () => {
    const own = await entryPhoto();
    const w = await wine(own.id);
    const c = await candidate(w.id);
    const view = await service.chooseReference(caveId, w.id, c.id);
    expect(view).toEqual({
      referencePhotoId: expect.any(String),
      referencePhotoSource: 'Open Food Facts (CC BY-SA)',
      referencePhotoSourceUrl: 'https://world.openfoodfacts.org/product/1',
    });
    const photo = await prisma.photo.findUniqueOrThrow({ where: { id: view.referencePhotoId! } });
    // L'image choisie appartient à la cave du vin.
    expect(photo).toMatchObject({ caveId, purpose: 'REFERENCE', status: 'DONE', storagePath: `normalized/${photo.id}.jpg`, mimeType: 'image/jpeg' });
    expect(existsSync(join(dir, 'normalized', `${photo.id}.jpg`))).toBe(true);
    const after = await prisma.wine.findUniqueOrThrow({ where: { id: w.id } });
    expect(after.referencePhotoPreviousId).toBe(own.id);
    // Une candidate ne sert qu'une fois.
    await expect(service.chooseReference(caveId, w.id, c.id)).rejects.toBeInstanceOf(GoneException);
  });

  it('choisir une seconde image du web garde la photo de l’utilisateur comme vignette d’avant, et efface la première image', async () => {
    const own = await entryPhoto();
    const w = await wine(own.id);
    const first = await service.chooseReference(caveId, w.id, (await candidate(w.id)).id);
    // Versions d’affichage gardées : l’actuelle (v2) comme celle de l’ancien traitement.
    writeFileSync(join(dir, 'normalized', `${first.referencePhotoId}.display-v2.jpg`), Buffer.from('v2'));
    writeFileSync(join(dir, 'normalized', `${first.referencePhotoId}.display.jpg`), Buffer.from('v1'));
    const second = await service.chooseReference(caveId, w.id, (await candidate(w.id, 'tempier.fr', 'https://tempier.fr/')).id);
    const after = await prisma.wine.findUniqueOrThrow({ where: { id: w.id } });
    expect(after).toMatchObject({
      referencePhotoId: second.referencePhotoId, referencePhotoPreviousId: own.id,
      referencePhotoSource: 'tempier.fr', referencePhotoSourceUrl: 'https://tempier.fr/',
    });
    expect(await prisma.photo.findUnique({ where: { id: first.referencePhotoId! } })).toBeNull();
    expect(existsSync(join(dir, 'normalized', `${first.referencePhotoId}.jpg`))).toBe(false);
    expect(existsSync(join(dir, 'normalized', `${first.referencePhotoId}.display-v2.jpg`))).toBe(false);
    expect(existsSync(join(dir, 'normalized', `${first.referencePhotoId}.display.jpg`))).toBe(false);
  });

  it('« Revenir à ma photo » rétablit la vignette d’avant, efface la source et l’image du web', async () => {
    const own = await entryPhoto();
    const w = await wine(own.id);
    const chosen = await service.chooseReference(caveId, w.id, (await candidate(w.id)).id);
    const view = await service.revertReference(caveId, w.id);
    expect(view).toEqual({ referencePhotoId: own.id, referencePhotoSource: null, referencePhotoSourceUrl: null });
    const after = await prisma.wine.findUniqueOrThrow({ where: { id: w.id } });
    expect(after.referencePhotoPreviousId).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: chosen.referencePhotoId! } })).toBeNull();
    // Sans image du web, revenir ne change rien.
    await expect(service.revertReference(caveId, w.id)).resolves.toEqual({ referencePhotoId: own.id, referencePhotoSource: null, referencePhotoSourceUrl: null });
  });

  it('un vin sans vignette y revient (vignette vide)', async () => {
    const w = await wine(null);
    await service.chooseReference(caveId, w.id, (await candidate(w.id)).id);
    await expect(service.revertReference(caveId, w.id)).resolves.toEqual({ referencePhotoId: null, referencePhotoSource: null, referencePhotoSourceUrl: null });
  });

  it('une candidate cherchée pour un vin ne peut pas devenir la vignette d’un autre (410)', async () => {
    const a = await wine(null);
    const b = await wine(null);
    const c = await candidate(a.id);
    const e = await service.chooseReference(caveId, b.id, c.id).catch((x) => x);
    expect(e).toBeInstanceOf(GoneException);
    expect(e.message).toBe('Proposition expirée, relancez la recherche');
    expect((await prisma.wine.findUniqueOrThrow({ where: { id: b.id } })).referencePhotoId).toBeNull();
    // Toujours utilisable pour le vin cherché.
    await expect(service.chooseReference(caveId, a.id, c.id)).resolves.toMatchObject({ referencePhotoSource: 'Open Food Facts (CC BY-SA)' });
  });

  it('depuis une autre cave : choisir ou revenir rend 404 « Vin introuvable » sans toucher au vin ni à la candidate', async () => {
    const own = await entryPhoto();
    const w = await wine(own.id);
    const c = await candidate(w.id);
    // Appels lancés un à un : créés d'avance, le second pouvait être rejeté
    // avant qu'on l'attende (rejet non géré, test instable).
    for (const call of [() => service.chooseReference(otherCaveId, w.id, c.id), () => service.revertReference(otherCaveId, w.id)]) {
      const e = await call().catch((x) => x);
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.message).toBe('Vin introuvable');
    }
    expect((await prisma.wine.findUniqueOrThrow({ where: { id: w.id } })).referencePhotoId).toBe(own.id);
    await expect(service.chooseReference(caveId, w.id, c.id)).resolves.toMatchObject({ referencePhotoSource: 'Open Food Facts (CC BY-SA)' });
  });

  it('sans vignette d’avant, « Revenir à ma photo » reprend la photo d’entrée la plus récente de ce vin', async () => {
    const w = await wine(null);
    const older = await entryPhoto();
    const newer = await entryPhoto();
    const other = await entryPhoto(); // photo d'un autre vin : jamais reprise
    const otherWine = await wine(null);
    for (const [photoId, wineId, at] of [[older.id, w.id, 1], [newer.id, w.id, 2], [other.id, otherWine.id, 3]] as const) {
      await prisma.photo.update({ where: { id: photoId }, data: { createdAt: new Date(Date.UTC(2026, 0, at)) } });
      const m = await prisma.movement.create({ data: { wineId, delta: 1, type: 'IN', photoId, idempotencyKey: key('ref-in') } });
      movementIds.push(m.id);
    }
    await service.chooseReference(caveId, w.id, (await candidate(w.id)).id);
    await expect(service.revertReference(caveId, w.id)).resolves.toEqual({ referencePhotoId: newer.id, referencePhotoSource: null, referencePhotoSourceUrl: null });
  });

  it('une photo REFERENCE n’apparaît jamais dans « À confirmer » ni dans la revue groupée', async () => {
    const photos = new PhotosService(prisma as never, new ImageNormalizationService(), dir, { add: jest.fn() } as never);
    const created: string[] = [];
    for (const status of ['PENDING', 'PROCESSING', 'DONE', 'FAILED'] as const) {
      const p = await prisma.photo.create({
        data: { caveId, contentHash: key('ref-list'), storagePath: 'normalized/r.jpg', status, purpose: 'REFERENCE', createdAt: new Date(Date.UTC(2000, 0, 1)) },
      });
      photoIds.push(p.id);
      created.push(p.id);
    }
    const inbox = await photos.entryInbox(caveId);
    const listed = [...inbox.toConfirm, ...inbox.inProgress, ...inbox.failed].map((p) => p.id);
    expect(listed.filter((id) => created.includes(id))).toEqual([]);
    expect((await photos.listPendingReview(caveId)).map((p) => p.id).filter((id) => created.includes(id))).toEqual([]);

    // L'attente (`queueStatus`), le lot d'entrée (réservation SQL `purpose = 'ENTRY'`) et la
    // reprise des orphelins (`purpose: 'EXIT'`) filtrent explicitement, vérifié par leurs tests
    // unitaires : relancés ici, ils compteraient ou toucheraient les photos des autres suites
    // qui tournent en parallèle sur la même base.
  });
});
