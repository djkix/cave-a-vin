import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppUser } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import supertest from 'supertest';
import { PRICE_KEYS } from './stats/stats';
import { createTestCave, deleteTestCaves } from './test-utils/cave';

/*
 * Étanchéité entre caves, route par route (spec multi-caves, section 8).
 *
 * Chaque route HTTP de l'application, lue dans le routeur Express une fois
 * l'AppModule monté, doit figurer dans la table ROUTES avec sa classe d'accès :
 *
 *   cave-viewer-read  lecture d'une cave, ouverte au membre (sans prix) ;
 *   cave-owner        réservée au propriétaire de la cave courante ;
 *   photo-image       image d'une photo, servie pour toute cave du compte ;
 *   admin             réservée à l'administrateur ;
 *   auth-public       connexion, session, santé.
 *
 * Une route absente de la table fait échouer la suite : une route ajoutée plus
 * tard doit être classée (et donc vérifiée) avant de passer la CI.
 *
 * Pour chaque route, sur des identifiants réels de la cave A, le petit
 * exécuteur en bas de fichier vérifie, selon la classe :
 *   - anonyme : 401 « Connexion requise » ;
 *   - compte en attente : 403 « Inscription en attente de validation » ;
 *   - compte actif sans cave : 404 « Cave introuvable » (admin : 403) ;
 *   - membre de A : lecture 2xx sans aucune clé de prix, écriture 403
 *     « Lecture seule » sans rien changer en base ;
 *   - propriétaire de B : 404 (message habituel) sur les identifiants de A, ou
 *     sa propre cave, jamais un identifiant de A dans la réponse, A inchangée ;
 *   - propriétaire de A : 2xx (chemin heureux), sauf « Chercher une image »
 *     (réseau et Gemini : couvert par image-search.service.spec) ;
 *   - administrateur : 2xx sur les lectures d'administration (les écritures
 *     d'administration sont couvertes par members, accounts et app.e2e).
 */
const describeIfInfra = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Kind = 'cave-viewer-read' | 'cave-owner' | 'photo-image' | 'admin' | 'auth-public';
type Expected = { status: number; message?: string };
type Ids = {
  caveA: string; caveB: string; wineA: string; wineA2: string; movementA: string; movementCancelA: string;
  photoA: string; photoDismissA: string; memberA: string; candidateA: string; producerKeyA: string;
  pendingUser: string; noCaveUser: string; locationA: string; wineB: string;
};
type Request = { url: string; body?: unknown; upload?: boolean };

interface Route {
  method: Method;
  /** Chemin tel que le routeur Express le connaît (préfixe /api compris). */
  path: string;
  kind: Kind;
  /** Requête portant sur les ressources de A (refus et, par défaut, chemin heureux). */
  req?: (ids: Ids) => Request;
  /**
   * Ce que reçoit le propriétaire de B pour cette requête : un statut (404 sur
   * un identifiant de A), ou 'own' (route sans identifiant : il agit sur sa
   * propre cave, et la réponse ne porte aucun identifiant de A).
   */
  foreign?: Expected | 'own' | ((res: supertest.Response) => void);
  /** Chemin heureux du propriétaire de A (ou de l'administrateur) ; `skip` documente pourquoi il est ailleurs. */
  happy?: { status: number; req?: (ids: Ids) => Request; check?: (res: supertest.Response, ids: Ids) => void } | { skip: string };
  /** Lecture : la réponse lue par A montre bien les données de A. */
  readable?: (res: supertest.Response, ids: Ids) => void;
}

const uuid = () => randomUUID();
const run = randomUUID().slice(0, 8);
const draft = (name: string) => ({ producer: `Domaine Iso ${run} ${name}`, appellationRaw: 'Bandol', vintage: 2015, color: 'ROUGE', formatCl: 75 });
const NOT_FOUND_WINE: Expected = { status: 404, message: 'Vin introuvable' };
const NOT_FOUND_PHOTO: Expected = { status: 404, message: 'Photo introuvable' };
const contains = (id: keyof Ids) => (res: supertest.Response, ids: Ids) => expect(res.text).toContain(ids[id]);

/** La table : une ligne par route HTTP de l'application. */
const ROUTES: Route[] = [
  // ── Lecture de cave (membre compris, sans prix) ─────────────────────────────
  { method: 'GET', path: '/api/cave', kind: 'cave-viewer-read', req: () => ({ url: '/api/cave?includeEmpty=true' }), foreign: 'own', readable: contains('wineA') },
  { method: 'GET', path: '/api/wines/:id', kind: 'cave-viewer-read', req: (i) => ({ url: `/api/wines/${i.wineA}` }), foreign: NOT_FOUND_WINE, readable: contains('wineA') },
  { method: 'GET', path: '/api/locations', kind: 'cave-viewer-read', req: () => ({ url: '/api/locations' }), foreign: 'own', readable: contains('locationA') },
  {
    method: 'GET', path: '/api/stats', kind: 'cave-viewer-read', req: () => ({ url: '/api/stats' }), foreign: 'own',
    readable: (res) => expect(res.body.bottles).toBeGreaterThan(0),
  },

  // ── Propriétaire : fiche vin ────────────────────────────────────────────────
  {
    method: 'POST', path: '/api/wines/:id/inventory', kind: 'cave-owner',
    req: (i) => ({ url: `/api/wines/${i.wineA}/inventory`, body: { idempotencyKey: uuid(), counted: 12 } }), foreign: NOT_FOUND_WINE, happy: { status: 201 },
  },
  {
    method: 'POST', path: '/api/wines/:id/move', kind: 'cave-owner',
    req: (i) => ({ url: `/api/wines/${i.wineA}/move`, body: { from: null, to: { zone: 'Iso', casier: 'B' }, quantity: 1 } }), foreign: NOT_FOUND_WINE,
    happy: { status: 201, check: (res) => expect(res.body.locations).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Iso / B', quantity: 1 })])) },
  },
  { method: 'GET', path: '/api/photos/:id/exit-candidates', kind: 'cave-owner', req: (i) => ({ url: `/api/photos/${i.photoA}/exit-candidates` }), foreign: NOT_FOUND_PHOTO, happy: { status: 200 } },
  {
    method: 'POST', path: '/api/wines/:id/quotes', kind: 'cave-owner',
    req: (i) => ({ url: `/api/wines/${i.wineA}/quotes`, body: { coteCents: 4200, quotedOn: '2026-01-15' } }), foreign: NOT_FOUND_WINE,
    happy: { status: 201, check: (res) => expect(res.body).toMatchObject({ coteCents: 4200, quotedOn: '2026-01-15', cessionCents: 3528 }) },
  },
  { method: 'PUT', path: '/api/wines/:id/apogee', kind: 'cave-owner', req: (i) => ({ url: `/api/wines/${i.wineA}/apogee`, body: { min: 2030, max: 2035 } }), foreign: NOT_FOUND_WINE, happy: { status: 200 } },
  { method: 'DELETE', path: '/api/wines/:id/apogee', kind: 'cave-owner', req: (i) => ({ url: `/api/wines/${i.wineA}/apogee` }), foreign: NOT_FOUND_WINE, happy: { status: 200 } },
  { method: 'PUT', path: '/api/wines/:id/rating', kind: 'cave-owner', req: (i) => ({ url: `/api/wines/${i.wineA}/rating`, body: { rating: 15 } }), foreign: NOT_FOUND_WINE, happy: { status: 200 } },
  { method: 'DELETE', path: '/api/wines/:id/rating', kind: 'cave-owner', req: (i) => ({ url: `/api/wines/${i.wineA}/rating` }), foreign: NOT_FOUND_WINE, happy: { status: 200 } },
  { method: 'POST', path: '/api/wines/:id/pairing/regenerate', kind: 'cave-owner', req: (i) => ({ url: `/api/wines/${i.wineA}/pairing/regenerate` }), foreign: NOT_FOUND_WINE, happy: { status: 202 } },

  // ── Propriétaire : « Chercher une image » ───────────────────────────────────
  {
    method: 'POST', path: '/api/wines/:id/image-search', kind: 'cave-owner', req: (i) => ({ url: `/api/wines/${i.wineA}/image-search` }), foreign: NOT_FOUND_WINE,
    happy: { skip: 'réseau et Gemini : couvert par image-search.service.spec (fournisseurs simulés)' },
  },
  {
    // Une candidate n'appartient qu'au vin pour lequel elle a été cherchée : hors
    // de sa cave elle est « expirée » (410), son message habituel d'inexistence.
    method: 'GET', path: '/api/image-candidates/:id', kind: 'cave-owner', req: (i) => ({ url: `/api/image-candidates/${i.candidateA}` }),
    foreign: { status: 410, message: 'Proposition expirée, relancez la recherche' }, happy: { status: 200 },
  },
  {
    method: 'POST', path: '/api/wines/:id/reference-image', kind: 'cave-owner',
    req: (i) => ({ url: `/api/wines/${i.wineA}/reference-image`, body: { candidateId: i.candidateA } }), foreign: NOT_FOUND_WINE,
    happy: { status: 200, check: (res) => expect(res.body.referencePhotoId).toEqual(expect.any(String)) },
  },
  { method: 'DELETE', path: '/api/wines/:id/reference-image', kind: 'cave-owner', req: (i) => ({ url: `/api/wines/${i.wineA}/reference-image` }), foreign: NOT_FOUND_WINE, happy: { status: 200 } },

  // ── Propriétaire : mouvements et journal ────────────────────────────────────
  {
    // B tente une entrée rattachée à une photo de A.
    method: 'POST', path: '/api/movements', kind: 'cave-owner',
    req: (i) => ({ url: '/api/movements', body: { idempotencyKey: uuid(), photoId: i.photoA, quantity: 1, wine: draft('photo-a') } }), foreign: NOT_FOUND_PHOTO,
    happy: { status: 201, req: () => ({ url: '/api/movements', body: { idempotencyKey: uuid(), quantity: 1, priceUnitCents: 1500, wine: draft('entrée') } }) },
  },
  {
    method: 'POST', path: '/api/movements/bulk', kind: 'cave-owner',
    req: (i) => ({ url: '/api/movements/bulk', body: [{ idempotencyKey: uuid(), photoId: i.photoA, quantity: 1, wine: draft('photo-a') }] }),
    foreign: (res) => {
      expect(res.status).toBe(201);
      expect(res.body).toEqual([expect.objectContaining({ ok: false, error: 'Photo introuvable' })]);
    },
    happy: { status: 201, req: () => ({ url: '/api/movements/bulk', body: [{ idempotencyKey: uuid(), quantity: 1, wine: draft('lot') }] }) },
  },
  {
    method: 'POST', path: '/api/movements/out', kind: 'cave-owner',
    req: (i) => ({ url: '/api/movements/out', body: { idempotencyKey: uuid(), wineId: i.wineA, quantity: 1 } }), foreign: NOT_FOUND_WINE, happy: { status: 201 },
  },
  {
    method: 'POST', path: '/api/movements/:id/cancel', kind: 'cave-owner',
    req: (i) => ({ url: `/api/movements/${i.movementA}/cancel`, body: { idempotencyKey: uuid() } }), foreign: { status: 404, message: 'Mouvement introuvable' },
    happy: { status: 201, req: (i) => ({ url: `/api/movements/${i.movementCancelA}/cancel`, body: { idempotencyKey: uuid() } }) },
  },
  { method: 'GET', path: '/api/movements/recent', kind: 'cave-owner', req: () => ({ url: '/api/movements/recent?limit=100' }), foreign: 'own', happy: { status: 200, check: contains('movementA') } },
  { method: 'GET', path: '/api/export.xlsx', kind: 'cave-owner', req: () => ({ url: '/api/export.xlsx' }), foreign: 'own', happy: { status: 200 } },

  // ── Propriétaire : membres et nom de la cave ────────────────────────────────
  { method: 'GET', path: '/api/caves/current/members', kind: 'cave-owner', req: () => ({ url: '/api/caves/current/members' }), foreign: 'own', happy: { status: 200, check: contains('memberA') } },
  {
    method: 'POST', path: '/api/caves/current/members', kind: 'cave-owner',
    req: () => ({ url: '/api/caves/current/members', body: { email: `iso-${run}-invite@example.test` } }), foreign: 'own', happy: { status: 201 },
  },
  {
    method: 'DELETE', path: '/api/caves/current/members/:id', kind: 'cave-owner', req: (i) => ({ url: `/api/caves/current/members/${i.memberA}` }),
    foreign: { status: 404, message: 'Membre introuvable' }, happy: { status: 204 },
  },
  { method: 'PATCH', path: '/api/caves/current', kind: 'cave-owner', req: () => ({ url: '/api/caves/current', body: { name: `Iso renommée ${run}` } }), foreign: 'own', happy: { status: 200 } },

  // ── Propriétaire : photos, « À confirmer », suivi ───────────────────────────
  { method: 'POST', path: '/api/photos', kind: 'cave-owner', req: () => ({ url: '/api/photos', upload: true }), foreign: 'own', happy: { status: 202 } },
  { method: 'GET', path: '/api/photos/queue-status', kind: 'cave-owner', req: () => ({ url: '/api/photos/queue-status' }), foreign: 'own', happy: { status: 200 } },
  { method: 'GET', path: '/api/photos/entry-inbox', kind: 'cave-owner', req: () => ({ url: '/api/photos/entry-inbox' }), foreign: 'own', happy: { status: 200, check: contains('photoA') } },
  { method: 'GET', path: '/api/photos/pending-review', kind: 'cave-owner', req: () => ({ url: '/api/photos/pending-review' }), foreign: 'own', happy: { status: 200, check: contains('photoA') } },
  {
    method: 'POST', path: '/api/photos/:id/dismiss', kind: 'cave-owner', req: (i) => ({ url: `/api/photos/${i.photoA}/dismiss` }), foreign: NOT_FOUND_PHOTO,
    happy: { status: 200, req: (i) => ({ url: `/api/photos/${i.photoDismissA}/dismiss` }) },
  },
  { method: 'GET', path: '/api/photos/:id', kind: 'cave-owner', req: (i) => ({ url: `/api/photos/${i.photoA}` }), foreign: NOT_FOUND_PHOTO, happy: { status: 200, check: contains('caveA') } },
  {
    method: 'GET', path: '/api/photos/:id/events', kind: 'cave-owner', req: (i) => ({ url: `/api/photos/${i.photoA}/events` }), foreign: NOT_FOUND_PHOTO,
    happy: { status: 200, check: (res) => expect(res.headers['content-type']).toContain('text/event-stream') },
  },

  // ── Image d'une photo : toute cave du compte, quel que soit le rôle ─────────
  { method: 'GET', path: '/api/photos/:id/image', kind: 'photo-image', req: (i) => ({ url: `/api/photos/${i.photoA}/image` }), foreign: NOT_FOUND_PHOTO, happy: { status: 200 } },

  // ── Administration ──────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/admin/users', kind: 'admin', req: () => ({ url: '/api/admin/users' }), happy: { status: 200 } },
  { method: 'PATCH', path: '/api/admin/users/:id', kind: 'admin', req: (i) => ({ url: `/api/admin/users/${i.pendingUser}`, body: { status: 'BLOCKED' } }) },
  { method: 'POST', path: '/api/admin/users/:id/cave', kind: 'admin', req: (i) => ({ url: `/api/admin/users/${i.noCaveUser}/cave` }) },
  { method: 'GET', path: '/api/admin/registrations', kind: 'admin', req: () => ({ url: '/api/admin/registrations' }), happy: { status: 200, check: contains('pendingUser') } },
  { method: 'POST', path: '/api/admin/registrations/:id/validate', kind: 'admin', req: (i) => ({ url: `/api/admin/registrations/${i.pendingUser}/validate` }) },
  { method: 'POST', path: '/api/admin/registrations/:id/refuse', kind: 'admin', req: (i) => ({ url: `/api/admin/registrations/${i.pendingUser}/refuse` }) },
  { method: 'GET', path: '/api/admin/budget', kind: 'admin', req: () => ({ url: '/api/admin/budget' }), happy: { status: 200 } },
  { method: 'PUT', path: '/api/admin/budget', kind: 'admin', req: () => ({ url: '/api/admin/budget', body: { caveShare: 1 } }) },
  { method: 'GET', path: '/api/admin/vintages', kind: 'admin', req: () => ({ url: '/api/admin/vintages' }), happy: { status: 200 } },
  { method: 'PUT', path: '/api/admin/vintages', kind: 'admin', req: () => ({ url: '/api/admin/vintages', body: { region: 'Bordeaux', year: 1900, quality: 'EXCEPTIONNEL' } }) },
  { method: 'DELETE', path: '/api/admin/vintages/:region/:year', kind: 'admin', req: () => ({ url: '/api/admin/vintages/Bordeaux/1900' }) },
  { method: 'GET', path: '/api/admin/guards', kind: 'admin', req: () => ({ url: '/api/admin/guards?q=bandol' }), happy: { status: 200 } },
  { method: 'PUT', path: '/api/admin/guards', kind: 'admin', req: () => ({ url: '/api/admin/guards', body: { appellationId: uuid(), guardMin: 1, guardMax: 2 } }) },
  { method: 'DELETE', path: '/api/admin/guards/:id', kind: 'admin', req: () => ({ url: `/api/admin/guards/${uuid()}` }) },
  { method: 'GET', path: '/api/admin/reading-quality', kind: 'admin', req: () => ({ url: '/api/admin/reading-quality' }), happy: { status: 200 } },
  {
    method: 'PUT', path: '/api/producers/:key/description', kind: 'admin',
    req: (i) => ({ url: `/api/producers/${encodeURIComponent(i.producerKeyA)}/description`, body: { description: 'Autre texte' } }),
  },
  { method: 'POST', path: '/api/producers/:key/regenerate', kind: 'admin', req: (i) => ({ url: `/api/producers/${encodeURIComponent(i.producerKeyA)}/regenerate` }) },

  // ── Connexion, session, santé (vérifications propres plus bas) ─────────────
  { method: 'GET', path: '/api/auth/google', kind: 'auth-public' },
  { method: 'GET', path: '/api/auth/google/callback', kind: 'auth-public' },
  { method: 'POST', path: '/api/auth/local-login', kind: 'auth-public' },
  { method: 'POST', path: '/api/auth/logout', kind: 'auth-public' },
  { method: 'GET', path: '/api/auth/me', kind: 'auth-public' },
  { method: 'PUT', path: '/api/auth/current-cave', kind: 'auth-public' },
  { method: 'GET', path: '/api/health', kind: 'auth-public' },
];

/** Clés de prix d'achat et de cote iDealwine (stats.ts, mouvements, fiche) et tout nom qui en évoque un. */
const PRICE_KEY = new RegExp(['price', 'purchase', 'expensive', 'cost', 'cote', 'quote', 'idealwine', 'cession', ...PRICE_KEYS].join('|'), 'i');
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}
const priceKeys = (body: unknown) => keysOf(body).filter((k) => PRICE_KEY.test(k));

describeIfInfra('étanchéité entre caves, route par route (HTTP)', () => {
  let app: INestApplication;
  let sessionRedis: { quit: () => Promise<unknown> };
  let prisma: import('./prisma/prisma.service').PrismaService;
  const storage = mkdtempSync(join(tmpdir(), 'cave-isolation-e2e-'));
  const userIds: string[] = [];
  const caveIds: string[] = [];
  const ids = {} as Ids;
  let caveAName: string;
  let jpeg: Buffer;
  const agents = {} as Record<'anonymous' | 'ownerA' | 'viewerA' | 'ownerB' | 'pending' | 'noCave' | 'admin', supertest.Agent>;

  beforeAll(async () => {
    process.env.SESSION_SECRET ??= 'e2e-secret-e2e-secret-e2e-secret-e2e-secret';
    process.env.GEMINI_API_KEY ??= 'invalid';
    process.env.WEB_ORIGIN ??= 'http://localhost:5173';
    process.env.PHOTO_STORAGE_DIR = storage;
    delete process.env.BREAK_GLASS_EMAIL;
    delete process.env.BREAK_GLASS_PASSWORD;

    const { AppModule } = await import('./app.module');
    const { setupSession } = await import('./auth/session.setup');
    const { PrismaService } = await import('./prisma/prisma.service');
    const { producerKeyOf } = await import('./producers/producer-key');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    sessionRedis = setupSession(app);
    prisma = app.get(PrismaService);
    // Middleware (pas une route) : il n'apparaît pas dans le routeur énuméré.
    app.use('/__test/login', (req: any, res: any) => {
      prisma.appUser
        .findUniqueOrThrow({ where: { id: String(req.query.id) } })
        .then((user) => req.logIn(user, (err: unknown) => (err ? res.status(500).end() : res.status(204).end())))
        .catch(() => res.status(500).end());
    });
    await app.listen(0, '127.0.0.1');

    jpeg = await sharp({ create: { width: 120, height: 160, channels: 3, background: '#6a1b2a' } }).jpeg().toBuffer();

    const user = async (name: string, data: Partial<AppUser> = {}) => {
      const u = await prisma.appUser.create({ data: { email: `iso-${run}-${name}@example.test`, displayName: `Iso ${name}`, ...data } });
      userIds.push(u.id);
      return u;
    };
    const uOwnerA = await user('owner-a');
    const uViewerA = await user('viewer-a');
    const uOwnerB = await user('owner-b');
    const uPending = await user('pending', { status: 'PENDING' });
    const uNoCave = await user('no-cave');
    const uAdmin = await user('admin', { isAdmin: true });
    caveAName = `Iso A ${run}`;
    ids.caveA = (await createTestCave(prisma, { owner: uOwnerA, name: caveAName })).id;
    ids.caveB = (await createTestCave(prisma, { owner: uOwnerB, name: `Iso B ${run}` })).id;
    caveIds.push(ids.caveA, ids.caveB);
    ids.pendingUser = uPending.id;
    ids.noCaveUser = uNoCave.id;
    await prisma.caveMember.create({ data: { caveId: ids.caveA, userId: uViewerA.id, role: 'VIEWER' } });
    ids.memberA = (await prisma.caveMember.create({ data: { caveId: ids.caveA, invitedEmail: `iso-${run}-invitee@example.test`, role: 'VIEWER' } })).id;

    const wine = (caveId: string, name: string) =>
      prisma.wine.create({ data: { caveId, matchKey: `iso-${run}-${name}`, producer: draft(name).producer, appellationRaw: 'Bandol', color: 'ROUGE', vintage: 2015 } });
    const a = await wine(ids.caveA, 'a');
    ids.wineA = a.id;
    ids.wineA2 = (await wine(ids.caveA, 'a2')).id;
    const wineB = (await wine(ids.caveB, 'b')).id;
    ids.movementA = (await prisma.movement.create({ data: { wineId: ids.wineA, delta: 12, type: 'IN', priceUnitCents: 4200, idempotencyKey: `iso-${run}-in-a` } })).id;
    ids.movementCancelA = (await prisma.movement.create({ data: { wineId: ids.wineA2, delta: 1, type: 'IN', priceUnitCents: 900, idempotencyKey: `iso-${run}-in-a2` } })).id;
    await prisma.movement.create({ data: { wineId: wineB, delta: 3, type: 'IN', priceUnitCents: 900, idempotencyKey: `iso-${run}-in-b` } });
    ids.wineB = wineB;
    // Cote de A : la fiche du propriétaire en porte une, celle du membre aucune clé.
    await prisma.priceQuote.create({ data: { wineId: ids.wineA, coteCents: 5000, quotedOn: new Date('2026-02-01'), sourceUrl: 'https://www.idealwine.com/fr/iso.jsp' } });
    ids.locationA = (await prisma.location.create({ data: { caveId: ids.caveA, zone: 'Cave A', casier: 'Iso', labelKey: 'cave a|iso|' } })).id;

    // Photo d'entrée lue, sans mouvement : « À confirmer » de A, avec son image sur disque.
    const photo = (name: string) =>
      prisma.photo.create({ data: { caveId: ids.caveA, contentHash: `iso-${run}-${name}`, storagePath: 'normalized/x.jpg', status: 'DONE', purpose: 'ENTRY' } });
    ids.photoA = (await photo('a')).id;
    ids.photoDismissA = (await photo('dismiss')).id;
    mkdirSync(join(storage, 'normalized'), { recursive: true });
    writeFileSync(join(storage, 'normalized', `${ids.photoA}.jpg`), jpeg);
    ids.candidateA = candidateFor(ids.wineA);

    ids.producerKeyA = producerKeyOf(a.producer);
    await prisma.producerProfile.create({ data: { producerKey: ids.producerKeyA, displayName: a.producer, status: 'DONE', source: 'MANUEL', description: 'Texte' } });

    const signedIn = async (u: AppUser) => {
      const agent = supertest.agent(app.getHttpServer());
      expect((await agent.get(`/__test/login?id=${u.id}`)).status).toBe(204);
      return agent;
    };
    agents.anonymous = supertest.agent(app.getHttpServer());
    agents.ownerA = await signedIn(uOwnerA);
    agents.viewerA = await signedIn(uViewerA);
    agents.ownerB = await signedIn(uOwnerB);
    agents.pending = await signedIn(uPending);
    agents.noCave = await signedIn(uNoCave);
    agents.admin = await signedIn(uAdmin);
  }, 120_000);

  afterAll(async () => {
    if (prisma && caveIds.length) {
      await deleteTestCaves(prisma, caveIds);
      await prisma.producerProfile.deleteMany({ where: { displayName: { startsWith: `Domaine Iso ${run}` } } });
      await prisma.cave.deleteMany({ where: { ownerId: { in: userIds } } });
      await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    }
    if (app) await app.close();
    if (sessionRedis) await sessionRedis.quit();
    rmSync(storage, { recursive: true, force: true });
  });

  /** Proposition d'image déjà téléchargée pour ce vin (pas de réseau). */
  function candidateFor(wineId: string): string {
    const id = randomUUID();
    const dir = join(storage, 'candidates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jpg`), jpeg);
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, wineId, source: 'Open Food Facts (CC BY-SA)', sourceUrl: 'https://world.openfoodfacts.org/product/1', createdAt: new Date().toISOString() }));
    return id;
  }

  function send(agent: supertest.Agent, method: Method, { url, body, upload }: Request): supertest.Test {
    const req = { GET: agent.get, POST: agent.post, PUT: agent.put, PATCH: agent.patch, DELETE: agent.delete }[method].call(agent, url);
    if (upload) return req.attach('file', jpeg, { filename: 'etiquette.jpg', contentType: 'image/jpeg' });
    return body === undefined ? req : req.send(body as object);
  }

  /** Ce qu'une requête refusée ne doit jamais changer : la cave A et les comptes de la suite. */
  async function snapshot(): Promise<string> {
    const inA = { caveId: ids.caveA };
    const [cave, members, wines, movements, photos, pairings, exports, costs, users, ownedCaves, profile, locations, quotes] = await Promise.all([
      prisma.cave.findUnique({ where: { id: ids.caveA } }),
      prisma.caveMember.findMany({ where: inA, orderBy: { id: 'asc' } }),
      prisma.wine.findMany({ where: inA, orderBy: { id: 'asc' } }),
      prisma.movement.findMany({ where: { wine: inA }, orderBy: { id: 'asc' } }),
      prisma.photo.findMany({ where: inA, orderBy: { id: 'asc' } }),
      prisma.pairing.findMany({ where: { wineId: { in: [ids.wineA, ids.wineA2] } } }),
      prisma.exportLog.count({ where: inA }),
      prisma.imageSearchCost.count({ where: inA }),
      prisma.appUser.findMany({ where: { id: { in: userIds } }, orderBy: { id: 'asc' }, select: { id: true, status: true, isAdmin: true } }),
      prisma.cave.count({ where: { ownerId: { in: userIds } } }),
      prisma.producerProfile.findUnique({ where: { producerKey: ids.producerKeyA } }),
      prisma.location.findMany({ where: inA, orderBy: { id: 'asc' } }),
      prisma.priceQuote.findMany({ where: { wine: inA }, orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify({ cave, members, wines, movements, photos, pairings, exports, costs, users, ownedCaves, profile, locations, quotes });
  }

  /** La requête, et la preuve qu'elle n'a rien changé à A. */
  async function refused(agent: supertest.Agent, route: Route, expected: Expected | ((res: supertest.Response) => void)) {
    const before = await snapshot();
    const res = await send(agent, route.method, route.req!(ids));
    if (typeof expected === 'function') expected(res);
    else expect({ status: res.status, message: res.body?.message }).toEqual({ status: expected.status, message: expected.message ?? res.body?.message });
    expect(await snapshot()).toEqual(before);
    return res;
  }

  /** Aucun identifiant ni nom de A dans une réponse lue par B. */
  function expectNothingOfA(res: supertest.Response) {
    for (const marker of [ids.caveA, ids.wineA, ids.wineA2, ids.movementA, ids.photoA, ids.memberA, ids.locationA, caveAName, `Domaine Iso ${run} a`]) {
      expect(res.text ?? '').not.toContain(marker);
    }
  }

  const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

  describe('classification', () => {
    /** Routes réellement montées : le routeur Express de l'application (Nest 10, Express 4). */
    function mountedRoutes(): string[] {
      const router = (app.getHttpAdapter().getInstance() as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router;
      return router.stack.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((m) => routeKey(m, layer.route!.path)) : []));
    }

    it('chaque route de l’application est classée dans la table', () => {
      const mounted = mountedRoutes();
      const classified = new Set(ROUTES.map((r) => routeKey(r.method, r.path)));
      expect(mounted.length).toBeGreaterThan(40);
      expect(mounted.filter((k) => !classified.has(k))).toEqual([]);
    });

    it('la table ne garde aucune route disparue ni aucun doublon', () => {
      const mounted = new Set(mountedRoutes());
      const keys = ROUTES.map((r) => routeKey(r.method, r.path));
      expect(keys.filter((k) => !mounted.has(k))).toEqual([]);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  for (const route of ROUTES.filter((r) => r.kind !== 'auth-public')) {
    describe(`${route.method} ${route.path} [${route.kind}]`, () => {
      it('anonyme : 401 « Connexion requise »', async () => {
        await refused(agents.anonymous, route, { status: 401, message: 'Connexion requise' });
      });

      it('compte en attente : 403 « Inscription en attente de validation »', async () => {
        await refused(agents.pending, route, { status: 403, message: 'Inscription en attente de validation' });
      });

      if (route.kind === 'admin') {
        it('comptes non administrateurs (propriétaire, membre, sans cave) : 403', async () => {
          for (const agent of [agents.ownerA, agents.viewerA, agents.noCave]) {
            await refused(agent, route, { status: 403, message: 'Réservé à l’administrateur' });
          }
        });
        if (route.happy && 'status' in route.happy) {
          const happy = route.happy;
          it(`administrateur : ${happy.status}`, async () => {
            const res = await send(agents.admin, route.method, route.req!(ids));
            expect(res.status).toBe(happy.status);
            happy.check?.(res, ids);
          });
        }
        return;
      }

      it(route.kind === 'photo-image' ? 'compte sans cave : 404 « Photo introuvable »' : 'compte sans cave : 404 « Cave introuvable »', async () => {
        await refused(agents.noCave, route, route.kind === 'photo-image' ? NOT_FOUND_PHOTO : { status: 404, message: 'Cave introuvable' });
      });

      if (route.kind === 'cave-owner') {
        it('membre de A : 403 « Lecture seule », base inchangée', async () => {
          await refused(agents.viewerA, route, { status: 403, message: 'Lecture seule' });
        });
      } else {
        it('propriétaire et membre de A : lu, sans aucune clé de prix pour le membre', async () => {
          const owner = await send(agents.ownerA, route.method, route.req!(ids));
          expect(owner.status).toBe(200);
          route.readable?.(owner, ids);
          const viewer = await send(agents.viewerA, route.method, route.req!(ids));
          expect(viewer.status).toBe(200);
          route.readable?.(viewer, ids);
          expect(priceKeys(viewer.body)).toEqual([]);
        });
      }

      const foreign = route.foreign!;
      it(foreign === 'own' ? 'propriétaire de B : sa cave seulement, rien de A' : 'propriétaire de B : identifiants de A introuvables, A inchangée', async () => {
        if (foreign === 'own') {
          const before = await snapshot();
          const res = await send(agents.ownerB, route.method, route.req!(ids));
          expect(res.status).toBeLessThan(300);
          expectNothingOfA(res);
          expect(await snapshot()).toEqual(before);
        } else {
          expectNothingOfA(await refused(agents.ownerB, route, foreign));
        }
      });

      const happy = route.happy;
      if (happy && 'skip' in happy) it.skip(`propriétaire de A : ${happy.skip}`, () => undefined);
      else if (happy) {
        it(`propriétaire de A : ${happy.status}`, async () => {
          const res = await send(agents.ownerA, route.method, (happy.req ?? route.req!)(ids));
          expect({ status: res.status, message: res.body?.message }).toEqual({ status: happy.status, message: undefined });
          happy.check?.(res, ids);
        });
      }
    });
  }

  describe('emplacements : ceux de A sont introuvables pour B', () => {
    it('sortie, inventaire, déplacement et filtre de B avec un emplacement de A : 404 « Emplacement introuvable », A inchangée', async () => {
      const notFound: Expected = { status: 404, message: 'Emplacement introuvable' };
      const routes: Array<[Method, Request]> = [
        ['POST', { url: '/api/movements/out', body: { idempotencyKey: uuid(), wineId: ids.wineB, quantity: 1, locationId: ids.locationA } }],
        ['POST', { url: `/api/wines/${ids.wineB}/inventory`, body: { idempotencyKey: uuid(), counted: 1, locationId: ids.locationA } }],
        ['POST', { url: `/api/wines/${ids.wineB}/move`, body: { from: ids.locationA, to: { zone: 'B' }, quantity: 1 } }],
        ['GET', { url: `/api/cave?location=${ids.locationA}` }],
      ];
      for (const [method, req] of routes) {
        expectNothingOfA(await refused(agents.ownerB, { method, path: req.url, kind: 'cave-owner', req: () => req }, notFound));
      }
    });

    it('la liste marque au plus un emplacement « lastUsed », celui de la dernière entrée rangée', async () => {
      // Entrée rangée à locationA, retirée ensuite : A revient à l'état commun aux autres cas.
      const m = await prisma.movement.create({ data: { wineId: ids.wineA, delta: 1, type: 'IN', locationId: ids.locationA, idempotencyKey: `iso-${run}-in-rangee` } });
      try {
        for (const agent of [agents.ownerA, agents.viewerA]) {
          const res = await agent.get('/api/locations');
          expect(res.status).toBe(200);
          expect(res.body.filter((l: { lastUsed: boolean }) => l.lastUsed).map((l: { id: string }) => l.id)).toEqual([ids.locationA]);
          expect(res.body.every((l: { lastUsed: unknown }) => typeof l.lastUsed === 'boolean')).toBe(true);
        }
        const b = await agents.ownerB.get('/api/locations');
        expect(b.body.some((l: { id: string; lastUsed: boolean }) => l.id === ids.locationA || l.lastUsed)).toBe(false);
      } finally {
        await prisma.movement.delete({ where: { id: m.id } });
      }
    });

    it('la fiche montre les emplacements au membre comme au propriétaire', async () => {
      for (const agent of [agents.ownerA, agents.viewerA]) {
        const res = await agent.get(`/api/wines/${ids.wineA}`);
        expect(res.status).toBe(200);
        expect(res.body.locations).toEqual(expect.any(Array));
        expect(res.body).toHaveProperty('lastLocation');
      }
    });
  });

  describe('prix : le propriétaire les reçoit, preuve que le contrôle du membre n’est pas vide', () => {
    it('statistiques du propriétaire de A : valeur d’achat et classement des plus chères', async () => {
      const res = await agents.ownerA.get('/api/stats');
      expect(res.status).toBe(200);
      expect(priceKeys(res.body)).toEqual(expect.arrayContaining([...PRICE_KEYS]));
    });

    it('fiche du propriétaire de A : cote courante et lien iDealwine (absents pour le membre, contrôlé plus haut)', async () => {
      const res = await agents.ownerA.get(`/api/wines/${ids.wineA}`);
      expect(res.status).toBe(200);
      expect(res.body.quote).toEqual(expect.objectContaining({ coteCents: expect.any(Number), cessionCents: expect.any(Number) }));
      expect(priceKeys(res.body)).toEqual(expect.arrayContaining(['quote', 'idealwineUrl', 'coteCents', 'quotedOn', 'cessionCents']));
      const viewer = await agents.viewerA.get(`/api/wines/${ids.wineA}`);
      expect(viewer.body).not.toHaveProperty('quote');
      expect(viewer.body).not.toHaveProperty('idealwineUrl');
    });
  });

  describe('connexion, session, santé', () => {
    it('santé : ouverte à tous', async () => {
      expect((await agents.anonymous.get('/api/health')).status).toBe(200);
      expect((await agents.pending.get('/api/health')).status).toBe(200);
    });

    it('/auth/me : le membre voit A en lecture, jamais B ; le compte en attente n’a aucune cave', async () => {
      const viewer = await agents.viewerA.get('/api/auth/me');
      expect(viewer.status).toBe(200);
      expect(viewer.body.caves).toEqual([expect.objectContaining({ id: ids.caveA, role: 'VIEWER' })]);
      const pending = await agents.pending.get('/api/auth/me');
      expect(pending.body).toMatchObject({ status: 'PENDING', caves: [], currentCaveId: null });
      expect((await agents.anonymous.get('/api/auth/me')).status).toBe(401);
    });

    it('/auth/current-cave : la cave d’un autre est introuvable ; refusée au compte en attente', async () => {
      const route: Route = { method: 'PUT', path: '/api/auth/current-cave', kind: 'auth-public', req: (i) => ({ url: '/api/auth/current-cave', body: { caveId: i.caveA } }) };
      await refused(agents.ownerB, route, { status: 404, message: 'Cave introuvable' });
      await refused(agents.noCave, route, { status: 404, message: 'Cave introuvable' });
      await refused(agents.pending, route, { status: 403, message: 'Inscription en attente de validation' });
      expect((await agents.ownerB.get('/api/cave')).text).not.toContain(ids.wineA);
    });

    it('connexion locale : identifiants inconnus refusés', async () => {
      const res = await agents.anonymous.post('/api/auth/local-login').send({ email: `iso-${run}-owner-a@example.test`, password: 'x' });
      expect({ status: res.status, message: res.body.message }).toEqual({ status: 401, message: 'Identifiants invalides' });
    });
  });
});
