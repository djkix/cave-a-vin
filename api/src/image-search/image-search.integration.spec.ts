import { GoneException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ImageNormalizationService } from '../photos/image-normalization.service';
import { PhotosService } from '../photos/photos.service';
import { CandidateStore } from './candidates';
import { ImageSearchService } from './image-search.service';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const key = (p: string) => `${p}-${Date.now()}-${Math.random()}`;

describeIfDb('image du web — choix, retour, exclusion des listes (base réelle)', () => {
  const prisma = new PrismaClient();
  const dir = mkdtempSync(join(tmpdir(), 'cave-reference-'));
  const wineIds: string[] = [];
  const photoIds: string[] = [];
  let jpeg: Buffer;
  const fetcher = jest.fn(async (url: string) => ({ buffer: jpeg, contentType: 'image/jpeg', finalUrl: url }));
  const store = new CandidateStore(dir, fetcher);
  const service = new ImageSearchService(prisma as never, store, {} as never, {} as never, dir, fetcher);

  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 300, height: 450, channels: 3, background: '#5b1a26' } }).jpeg().toBuffer();
  });

  afterAll(async () => {
    const wines = await prisma.wine.findMany({ where: { id: { in: wineIds } }, select: { referencePhotoId: true } });
    await prisma.wine.deleteMany({ where: { id: { in: wineIds } } });
    await prisma.photo.deleteMany({ where: { id: { in: [...photoIds, ...wines.map((w) => w.referencePhotoId!).filter(Boolean)] } } });
    await prisma.$disconnect();
  });

  async function wine(referencePhotoId: string | null = null) {
    const w = await prisma.wine.create({
      data: { matchKey: key('ref'), producer: 'Domaine Tempier', appellationRaw: 'Bandol', color: 'ROUGE', referencePhotoId },
    });
    wineIds.push(w.id);
    return w;
  }

  async function entryPhoto() {
    const p = await prisma.photo.create({ data: { contentHash: key('own'), storagePath: 'normalized/own.jpg', status: 'DONE', purpose: 'ENTRY' } });
    photoIds.push(p.id);
    return p;
  }

  async function candidate(source = 'Open Food Facts (CC BY-SA)', sourceUrl = 'https://world.openfoodfacts.org/product/1') {
    return (await store.add({ imageUrl: 'https://images.exemple/x.jpg', source, sourceUrl }))!;
  }

  it('la candidate devient une photo REFERENCE DONE et la vignette ; l’ancienne vignette est mémorisée', async () => {
    const own = await entryPhoto();
    const w = await wine(own.id);
    const c = await candidate();
    const view = await service.chooseReference(w.id, c.id);
    expect(view).toEqual({
      referencePhotoId: expect.any(String),
      referencePhotoSource: 'Open Food Facts (CC BY-SA)',
      referencePhotoSourceUrl: 'https://world.openfoodfacts.org/product/1',
    });
    const photo = await prisma.photo.findUniqueOrThrow({ where: { id: view.referencePhotoId! } });
    expect(photo).toMatchObject({ purpose: 'REFERENCE', status: 'DONE', storagePath: `normalized/${photo.id}.jpg`, mimeType: 'image/jpeg' });
    expect(existsSync(join(dir, 'normalized', `${photo.id}.jpg`))).toBe(true);
    const after = await prisma.wine.findUniqueOrThrow({ where: { id: w.id } });
    expect(after.referencePhotoPreviousId).toBe(own.id);
    // Une candidate ne sert qu'une fois.
    await expect(service.chooseReference(w.id, c.id)).rejects.toBeInstanceOf(GoneException);
  });

  it('choisir une seconde image du web garde la photo de l’utilisateur comme vignette d’avant, et efface la première image', async () => {
    const own = await entryPhoto();
    const w = await wine(own.id);
    const first = await service.chooseReference(w.id, (await candidate()).id);
    const second = await service.chooseReference(w.id, (await candidate('tempier.fr', 'https://tempier.fr/')).id);
    const after = await prisma.wine.findUniqueOrThrow({ where: { id: w.id } });
    expect(after).toMatchObject({
      referencePhotoId: second.referencePhotoId, referencePhotoPreviousId: own.id,
      referencePhotoSource: 'tempier.fr', referencePhotoSourceUrl: 'https://tempier.fr/',
    });
    expect(await prisma.photo.findUnique({ where: { id: first.referencePhotoId! } })).toBeNull();
    expect(existsSync(join(dir, 'normalized', `${first.referencePhotoId}.jpg`))).toBe(false);
  });

  it('« Revenir à ma photo » rétablit la vignette d’avant, efface la source et l’image du web', async () => {
    const own = await entryPhoto();
    const w = await wine(own.id);
    const chosen = await service.chooseReference(w.id, (await candidate()).id);
    const view = await service.revertReference(w.id);
    expect(view).toEqual({ referencePhotoId: own.id, referencePhotoSource: null, referencePhotoSourceUrl: null });
    const after = await prisma.wine.findUniqueOrThrow({ where: { id: w.id } });
    expect(after.referencePhotoPreviousId).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: chosen.referencePhotoId! } })).toBeNull();
    // Sans image du web, revenir ne change rien.
    await expect(service.revertReference(w.id)).resolves.toEqual({ referencePhotoId: own.id, referencePhotoSource: null, referencePhotoSourceUrl: null });
  });

  it('un vin sans vignette y revient (vignette vide)', async () => {
    const w = await wine(null);
    await service.chooseReference(w.id, (await candidate()).id);
    await expect(service.revertReference(w.id)).resolves.toEqual({ referencePhotoId: null, referencePhotoSource: null, referencePhotoSourceUrl: null });
  });

  it('une photo REFERENCE n’apparaît jamais dans « À confirmer » ni dans la revue groupée', async () => {
    const photos = new PhotosService(prisma as never, new ImageNormalizationService(), dir, { add: jest.fn() } as never);
    const created: string[] = [];
    for (const status of ['PENDING', 'PROCESSING', 'DONE', 'FAILED'] as const) {
      const p = await prisma.photo.create({
        data: { contentHash: key('ref-list'), storagePath: 'normalized/r.jpg', status, purpose: 'REFERENCE', createdAt: new Date(Date.UTC(2000, 0, 1)) },
      });
      photoIds.push(p.id);
      created.push(p.id);
    }
    const inbox = await photos.entryInbox();
    const listed = [...inbox.toConfirm, ...inbox.inProgress, ...inbox.failed].map((p) => p.id);
    expect(listed.filter((id) => created.includes(id))).toEqual([]);
    expect((await photos.listPendingReview()).map((p) => p.id).filter((id) => created.includes(id))).toEqual([]);

    // L'attente (`queueStatus`), le lot d'entrée (réservation SQL `purpose = 'ENTRY'`) et la
    // reprise des orphelins (`purpose: 'EXIT'`) filtrent explicitement, vérifié par leurs tests
    // unitaires : relancés ici, ils compteraient ou toucheraient les photos des autres suites
    // qui tournent en parallèle sur la même base.
  });
});
