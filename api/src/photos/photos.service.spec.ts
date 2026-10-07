import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { ImageNormalizationService } from './image-normalization.service';
import { PhotosService } from './photos.service';

function fakePrisma() {
  const photos: any[] = [];
  return {
    photos,
    cave: { findFirst: async () => ({ id: 'c1' }) },
    photo: {
      findUnique: async ({ where }: any) =>
        photos.find((p) =>
          where.caveId_contentHash
            ? p.caveId === where.caveId_contentHash.caveId && p.contentHash === where.caveId_contentHash.contentHash
            : p.id === where.id,
        ) ?? null,
      create: async ({ data }: any) => {
        const p = { id: data.id ?? `p${photos.length + 1}`, status: 'PENDING', purpose: 'ENTRY', createdAt: new Date(), ...data };
        photos.push(p);
        return p;
      },
      delete: jest.fn(async ({ where }: any) => {
        const idx = photos.findIndex((p) => p.id === where.id);
        if (idx === -1) throw new Error('not found');
        const [removed] = photos.splice(idx, 1);
        return removed;
      }),
      findMany: async () => photos,
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = photos.filter((p) => p.id === where.id && p.purpose === where.purpose && !p.hasMovement);
        hit.forEach((p) => Object.assign(p, data));
        return { count: hit.length };
      }),
    },
  };
}

describe('PhotosService.ingest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cave-photos-'));

  it('stores original + normalized and creates a PENDING row, sans travail BullMQ pour une entrée', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const { photo, duplicate } = await service.ingest(img, 'image/jpeg');
    expect(duplicate).toBe(false);
    expect(photo.status).toBe('PENDING');
    // TODO(multi-caves) : la cave de l'ancien fonctionnement, en attendant la cave courante.
    expect(photo.caveId).toBe('c1');
    expect(existsSync(join(dir, 'original', `${photo.id}.jpg`))).toBe(true);
    expect(existsSync(join(dir, 'normalized', `${photo.id}.jpg`))).toBe(true);
    // L'analyse d'entrée se fait désormais par lot depuis la base : aucun travail
    // BullMQ n'est créé pour une photo ENTRY.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns the existing row for the same bytes, toujours sans travail BullMQ', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#111' } }).jpeg().toBuffer();
    const a = await service.ingest(img, 'image/jpeg');
    const b = await service.ingest(img, 'image/jpeg');
    expect(b.duplicate).toBe(true);
    expect(b.photo.id).toBe(a.photo.id);
    expect(prisma.photos).toHaveLength(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rend à l’entrée une photo de sortie sans mouvement quand les mêmes octets arrivent en entrée', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#222' } }).jpeg().toBuffer();
    const exit = await service.ingest(img, 'image/jpeg', 'EXIT');
    const entry = await service.ingest(img, 'image/jpeg', 'ENTRY');
    expect(entry.duplicate).toBe(true);
    expect(entry.photo.id).toBe(exit.photo.id);
    expect(entry.photo.purpose).toBe('ENTRY');
    expect(prisma.photos[0].purpose).toBe('ENTRY');
  });

  it('laisse en sortie une photo de sortie qui a déjà servi à un mouvement', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#333' } }).jpeg().toBuffer();
    await service.ingest(img, 'image/jpeg', 'EXIT');
    prisma.photos[0].hasMovement = true;
    const entry = await service.ingest(img, 'image/jpeg', 'ENTRY');
    expect(entry.photo.purpose).toBe('EXIT');
  });

  it('recovers from a concurrent duplicate create (P2002) by cleaning up files and returning the existing row', async () => {
    const raceDir = mkdtempSync(join(tmpdir(), 'cave-photos-race-'));
    const existingRow = {
      id: 'raced-id',
      contentHash: 'raced-hash',
      status: 'PENDING',
      createdAt: new Date(),
      storagePath: 'normalized/raced-id.jpg',
      mimeType: 'image/jpeg',
    };
    let findUniqueCalls = 0;
    let createCalls = 0;
    const prisma = {
      cave: { findFirst: async () => ({ id: 'c1' }) },
      photo: {
        findUnique: async () => {
          findUniqueCalls += 1;
          return findUniqueCalls === 1 ? null : existingRow;
        },
        create: async () => {
          createCalls += 1;
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        },
        findMany: async () => [],
      },
    };
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), raceDir, queue as any);
    const img = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#222' } }).jpeg().toBuffer();
    const result = await service.ingest(img, 'image/jpeg');
    expect(result.duplicate).toBe(true);
    expect(result.photo).toBe(existingRow);
    expect(createCalls).toBe(1);
    expect(readdirSync(join(raceDir, 'original'))).toHaveLength(0);
    expect(readdirSync(join(raceDir, 'normalized'))).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects an unreadable image with a BadRequestException and creates no row', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    await expect(service.ingest(Buffer.from('not an image'), 'image/jpeg')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.photos).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rolls back the photo row and files, and returns 503, when the queue cannot accept the job (sortie, seule à encore mettre en file)', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn(async () => { throw new Error('redis down'); }) };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#333' } }).jpeg().toBuffer();
    await expect(service.ingest(img, 'image/jpeg', 'EXIT')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.photo.delete).toHaveBeenCalledTimes(1);
    const deletedId = (prisma.photo.delete as jest.Mock).mock.calls[0][0].where.id;
    expect(prisma.photos).toHaveLength(0);
    expect(readdirSync(join(dir, 'original')).some((f) => f.startsWith(deletedId))).toBe(false);
    expect(readdirSync(join(dir, 'normalized')).some((f) => f.startsWith(deletedId))).toBe(false);
  });

  it('met une photo de sortie en file avec la politique courte (deux tentatives, sans report)', async () => {
    const prisma = fakePrisma();
    const queue = { add: jest.fn() };
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, queue as any);
    const img = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#456' } }).jpeg().toBuffer();
    const { photo } = await service.ingest(img, 'image/jpeg', 'EXIT');
    expect(photo.purpose).toBe('EXIT');
    expect(queue.add).toHaveBeenCalledWith(
      'extract',
      { photoId: photo.id },
      { jobId: photo.id, attempts: 2, backoff: { type: 'fixed', delay: 3000 } },
    );
  });
});

describe('PhotosService.queueStatus', () => {
  function service(rows: { createdAt: Date; errorMessage: string | null }[]) {
    const prisma = {
      photo: {
        count: jest.fn(async () => rows.length),
        findFirst: jest.fn(async ({ where, orderBy }: any) => {
          const candidates = where.errorMessage ? rows.filter((r) => r.errorMessage !== null) : rows;
          const sorted = [...candidates].sort((a, b) =>
            orderBy.createdAt === 'asc' ? a.createdAt.getTime() - b.createdAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime(),
          );
          return sorted[0] ?? null;
        }),
      },
    };
    return new PhotosService(prisma as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
  }

  it('annonce une file vide quand tout est analysé', async () => {
    expect(await service([]).queueStatus()).toEqual({ waiting: 0, oldestWaitingAt: null, lastReason: null });
  });

  it('compte les photos en attente, donne la plus ancienne et le dernier motif de report', async () => {
    const old = new Date('2026-09-21T10:00:00Z');
    const recent = new Date('2026-09-21T12:00:00Z');
    const status = await service([
      { createdAt: old, errorMessage: null },
      { createdAt: recent, errorMessage: 'Analyse reportée : service Gemini momentanément saturé, reprise automatique' },
    ]).queueStatus();
    expect(status.waiting).toBe(2);
    expect(status.oldestWaitingAt).toEqual(old);
    expect(status.lastReason).toContain('saturé');
  });
});

describe('PhotosService — photos de sortie tenues à l’écart', () => {
  it('ne liste dans la revue groupée que les photos d’entrée', async () => {
    const findMany = jest.fn(async () => []);
    const service = new PhotosService({ photo: { findMany } } as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    await service.listPendingReview();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'DONE', purpose: 'ENTRY', movements: { none: {} }, dismissedAt: null } }),
    );
  });

  it('exclut une photo écartée de la revue groupée', async () => {
    const photos = [
      { id: 'kept', status: 'DONE', purpose: 'ENTRY', dismissedAt: null, createdAt: new Date() },
      { id: 'dismissed', status: 'DONE', purpose: 'ENTRY', dismissedAt: new Date(), createdAt: new Date() },
    ];
    const findMany = jest.fn(async ({ where }: any) => photos.filter(
      (p) => p.status === where.status && p.purpose === where.purpose && p.dismissedAt === where.dismissedAt,
    ));
    const service = new PhotosService({ photo: { findMany } } as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    const result = await service.listPendingReview();
    expect(result.map((p) => p.id)).toEqual(['kept']);
  });

  it('ne compte dans l’attente que les photos d’entrée', async () => {
    const count = jest.fn(async () => 0);
    const findFirst = jest.fn(async () => null);
    const service = new PhotosService({ photo: { count, findFirst } } as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    await service.queueStatus();
    expect(count).toHaveBeenCalledWith({ where: expect.objectContaining({ status: { in: ['PENDING', 'PROCESSING'] }, purpose: 'ENTRY' }) });
  });

  it('ne compte pas dans l’attente les photos écartées', async () => {
    const rows = [
      { status: 'PENDING', purpose: 'ENTRY', dismissedAt: null, createdAt: new Date('2026-10-05T10:00:00Z'), errorMessage: null },
      { status: 'PENDING', purpose: 'ENTRY', dismissedAt: new Date(), createdAt: new Date('2026-10-05T09:00:00Z'), errorMessage: 'motif ancien' },
    ];
    const keep = (where: any) =>
      rows.filter(
        (r) =>
          where.status.in.includes(r.status) &&
          r.purpose === where.purpose &&
          ('dismissedAt' in where ? r.dismissedAt === where.dismissedAt : true) &&
          (where.errorMessage ? r.errorMessage !== null : true),
      );
    const count = jest.fn(async ({ where }: any) => keep(where).length);
    const findFirst = jest.fn(async ({ where }: any) => keep(where)[0] ?? null);
    const service = new PhotosService({ photo: { count, findFirst } } as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    const status = await service.queueStatus();
    expect(status.waiting).toBe(1);
    expect(status.oldestWaitingAt).toEqual(new Date('2026-10-05T10:00:00Z'));
    expect(status.lastReason).toBeNull();
    expect(count).toHaveBeenCalledWith({ where: expect.objectContaining({ dismissedAt: null }) });
  });
});

describe('PhotosService.entryInbox', () => {
  function service(photos: any[]) {
    const prisma = {
      photo: {
        findMany: jest.fn(async ({ where, orderBy }: any) => {
          let rows = photos.filter((p) => p.purpose === where.purpose && p.dismissedAt === where.dismissedAt);
          if (Array.isArray(where.status.in)) {
            rows = rows.filter((p) => where.status.in.includes(p.status));
          } else {
            rows = rows.filter((p) => p.status === where.status);
          }
          rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          void orderBy;
          return rows.slice(0, 200);
        }),
      },
    };
    return { prisma, svc: new PhotosService(prisma as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any) };
  }

  it('répartit les photos d’entrée non écartées en trois sections, triées par date de création', async () => {
    const t0 = new Date('2026-09-21T10:00:00Z');
    const t1 = new Date('2026-09-21T11:00:00Z');
    const photos = [
      { id: 'done-1', purpose: 'ENTRY', status: 'DONE', dismissedAt: null, createdAt: t0, rawExtraction: null },
      { id: 'pending-1', purpose: 'ENTRY', status: 'PENDING', dismissedAt: null, createdAt: t1, rawExtraction: null },
      { id: 'processing-1', purpose: 'ENTRY', status: 'PROCESSING', dismissedAt: null, createdAt: t0, rawExtraction: null },
      { id: 'failed-1', purpose: 'ENTRY', status: 'FAILED', dismissedAt: null, createdAt: t1, rawExtraction: null },
    ];
    const { svc } = service(photos);
    const inbox = await svc.entryInbox();
    expect(inbox.toConfirm.map((p) => p.id)).toEqual(['done-1']);
    expect(inbox.inProgress.map((p) => p.id)).toEqual(['processing-1', 'pending-1']);
    expect(inbox.failed.map((p) => p.id)).toEqual(['failed-1']);
  });

  it('exclut les photos de sortie et les photos écartées', async () => {
    const t0 = new Date('2026-09-21T10:00:00Z');
    const photos = [
      { id: 'exit-done', purpose: 'EXIT', status: 'DONE', dismissedAt: null, createdAt: t0, rawExtraction: null },
      { id: 'dismissed-done', purpose: 'ENTRY', status: 'DONE', dismissedAt: new Date(), createdAt: t0, rawExtraction: null },
      { id: 'kept-done', purpose: 'ENTRY', status: 'DONE', dismissedAt: null, createdAt: t0, rawExtraction: null },
    ];
    const { svc } = service(photos);
    const inbox = await svc.entryInbox();
    expect(inbox.toConfirm.map((p) => p.id)).toEqual(['kept-done']);
  });

  it('fournit l’extraction analysée pour toConfirm, null si illisible', async () => {
    const t0 = new Date('2026-09-21T10:00:00Z');
    const photos = [
      { id: 'bad-json', purpose: 'ENTRY', status: 'DONE', dismissedAt: null, createdAt: t0, rawExtraction: { not: 'valid' } },
    ];
    const { svc } = service(photos);
    const inbox = await svc.entryInbox();
    expect(inbox.toConfirm).toHaveLength(1);
    expect(inbox.toConfirm[0].extraction).toBeNull();
  });
});

describe('PhotosService.dismiss', () => {
  it('rejette avec 404 quand la photo est introuvable', async () => {
    const prisma = { photo: { findUnique: jest.fn(async () => null) } };
    const svc = new PhotosService(prisma as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    await expect(svc.dismiss('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejette avec 409 quand un mouvement référence déjà la photo', async () => {
    const prisma = {
      photo: {
        findUnique: jest.fn(async () => ({ id: 'p1', movements: [{ id: 'm1' }] })),
        update: jest.fn(),
      },
    };
    const svc = new PhotosService(prisma as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    await expect(svc.dismiss('p1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.photo.update).not.toHaveBeenCalled();
  });

  it('écarte la photo (dismissedAt renseigné) quand aucun mouvement ne la référence', async () => {
    const prisma = {
      photo: {
        findUnique: jest.fn(async () => ({ id: 'p1', movements: [] })),
        update: jest.fn(async ({ data }: any) => ({ id: 'p1', ...data })),
      },
    };
    const svc = new PhotosService(prisma as any, new ImageNormalizationService(), '/tmp', { add: jest.fn() } as any);
    await svc.dismiss('p1');
    expect(prisma.photo.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { dismissedAt: expect.any(Date) } });
  });
});

describe('PhotosService.readDisplay', () => {
  const lecture = (etiquette?: unknown) => ({
    producteur: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: null, confidence: 0 },
    appellation: { value: 'Bandol', confidence: 0.97 }, millesime: { value: 2019, confidence: 0.94 },
    couleur: { value: 'rouge', confidence: 0.99 }, format_cl: { value: 75, confidence: 0.9 },
    degre: { value: null, confidence: 0 }, pays_region: { value: 'Provence', confidence: 0.7 },
    nb_cols_carton: { value: null, confidence: 0 }, confiance_globale: 0.93,
    ...(etiquette === undefined ? {} : { etiquette }),
  });

  async function setup(row: Record<string, unknown>, image?: Buffer) {
    const dir = mkdtempSync(join(tmpdir(), 'cave-display-'));
    mkdirSync(join(dir, 'normalized'), { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111';
    const original = image ?? (await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#8a6a50' } }).jpeg().toBuffer());
    writeFileSync(join(dir, 'normalized', `${id}.jpg`), original);
    const prisma = fakePrisma();
    prisma.photos.push({ id, contentHash: 'h', status: 'DONE', purpose: 'ENTRY', rawExtraction: null, ...row });
    const service = new PhotosService(prisma as any, new ImageNormalizationService(), dir, { add: jest.fn() } as any);
    return { dir, id, original, service, displayPath: join(dir, 'normalized', `${id}.display-v2.jpg`) };
  }

  it('recadre sur l’étiquette (marge de 8 %) et garde la version d’affichage sur le disque', async () => {
    const { id, service, displayPath } = await setup({ rawExtraction: lecture([250, 250, 750, 750]) });
    const out = await service.readDisplay(id);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([580, 464]);
    expect(existsSync(displayPath)).toBe(true);
    expect(readFileSync(displayPath).equals(out)).toBe(true);
  });

  it('ne recadre pas sans cadre plausible, et ramène l’image à 1200 px au plus', async () => {
    const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#777777' } }).jpeg().toBuffer();
    const { id, service } = await setup({ rawExtraction: lecture([0, 0, 1000, 1000]) }, big);
    const meta = await sharp(await service.readDisplay(id)).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 900]);
  });

  it('corrige une dominante de couleur (balance des blancs « monde gris »)', async () => {
    // Moitié gauche plus claire que la droite, le tout tiré vers le rouge.
    const left = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 150, b: 130 } } }).png().toBuffer();
    const img = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 120, g: 80, b: 70 } } })
      .composite([{ input: left, left: 0, top: 0 }]).jpeg().toBuffer();
    const { id, service } = await setup({ status: 'FAILED', rawExtraction: null }, img);
    const before = (await sharp(img).stats()).channels.map((c) => c.mean);
    const after = (await sharp(await service.readDisplay(id)).stats()).channels.map((c) => c.mean);
    expect(after[0] - after[2]).toBeLessThan(before[0] - before[2]);
  });

  it('ignore une version gardée par l’ancien traitement (<id>.display.jpg) et la refabrique', async () => {
    const { dir, id, service, displayPath } = await setup({ rawExtraction: lecture(null) });
    writeFileSync(join(dir, 'normalized', `${id}.display.jpg`), Buffer.from('ancienne-retouche'));
    const out = await service.readDisplay(id);
    expect(out.toString()).not.toBe('ancienne-retouche');
    expect((await sharp(out).metadata()).format).toBe('jpeg');
    expect(existsSync(displayPath)).toBe(true);
  });

  it('retouche avec douceur : étiquette crème, fond olive et texte bordeaux gardent leurs couleurs', async () => {
    // Fond olive, étiquette crème (lignes 200..600, colonnes 250..750), texte bordeaux dans l’étiquette.
    const label = await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 240, g: 235, b: 220 } } }).png().toBuffer();
    const text = await sharp({ create: { width: 200, height: 40, channels: 3, background: '#5C2423' } }).png().toBuffer();
    const img = await sharp({ create: { width: 1000, height: 800, channels: 3, background: { r: 150, g: 140, b: 90 } } })
      .composite([{ input: label, left: 250, top: 200 }, { input: text, left: 400, top: 380 }])
      .jpeg({ quality: 95 }).toBuffer();
    const { id, service } = await setup({ rawExtraction: lecture([250, 250, 750, 750]) }, img);
    const out = await service.readDisplay(id);
    // Recadrage : left 210, top 168 → étiquette en x 40..540, y 32..432 ; texte en x 190..390, y 212..252.
    const means = async (left: number, top: number, width: number, height: number) =>
      (await sharp(out).extract({ left, top, width, height }).stats()).channels.map((c) => c.mean);
    const [cr, cg, cb] = await means(60, 50, 100, 50);
    expect(cr - cb).toBeGreaterThanOrEqual(8);
    expect(cg).toBeGreaterThan(cb);
    const [or, og, ob] = await means(0, 0, 30, 464);
    expect(0.2126 * or + 0.7152 * og + 0.0722 * ob).toBeGreaterThanOrEqual(80);
    expect(og).toBeGreaterThan(ob);
    const [tr, , tb] = await means(220, 220, 140, 24);
    expect(tr).toBeGreaterThan(tb);
    expect(tr).toBeGreaterThan(60);
  });

  it('réutilise la version d’affichage déjà fabriquée', async () => {
    const { id, service, displayPath } = await setup({ rawExtraction: lecture(null) });
    await service.readDisplay(id);
    writeFileSync(displayPath, Buffer.from('déjà-fabriquée'));
    expect((await service.readDisplay(id)).toString()).toBe('déjà-fabriquée');
  });

  it('rend l’image d’origine, sans rien garder, pour une photo en attente ou en cours', async () => {
    for (const status of ['PENDING', 'PROCESSING']) {
      const { id, service, original, displayPath } = await setup({ status });
      expect((await service.readDisplay(id)).equals(original)).toBe(true);
      expect(existsSync(displayPath)).toBe(false);
    }
  });

  it('rend l’image d’origine et journalise l’erreur si la fabrication échoue', async () => {
    const garbage = Buffer.from('pas une image');
    const { id, service, displayPath } = await setup({ rawExtraction: lecture([250, 250, 750, 750]) }, garbage);
    const error = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    expect((await service.readDisplay(id)).equals(garbage)).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(id));
    expect(existsSync(displayPath)).toBe(false);
  });

  it('refuse une photo inconnue (404)', async () => {
    const { service } = await setup({});
    await expect(service.readDisplay('22222222-2222-4222-8222-222222222222')).rejects.toBeInstanceOf(NotFoundException);
  });
});
