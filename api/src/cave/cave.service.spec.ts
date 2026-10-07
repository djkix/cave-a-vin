import { NotFoundException } from '@nestjs/common';
import { compileApogeeRules } from '../apogee/apogee';
import { CaveRow } from './cave-filter';
import { LocationsService } from '../locations/locations.service';
import { CaveService } from './cave.service';

const tempier19: CaveRow = {
  id: 'w19', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019,
  color: 'ROUGE', formatCl: 75, referencePhotoId: 'ref19', quantity: 2,
};
const raw = (vintage: number | null) => ({
  producteur: { value: 'Domaine Tempier', confidence: 0.9 }, cuvee: { value: 'La Tourtine', confidence: 0.9 },
  appellation: { value: 'Bandol', confidence: 0.9 }, millesime: { value: vintage, confidence: vintage ? 0.9 : 0 },
  couleur: { value: 'rouge', confidence: 0.9 }, format_cl: { value: 75, confidence: 0.9 }, degre: { value: null, confidence: 0 },
  pays_region: { value: null, confidence: 0 }, nb_cols_carton: { value: null, confidence: 0 }, confiance_globale: 0.9,
});

function service(photo: any, rows: any[] = [tempier19], rules = compileApogeeRules({ guardOverrides: [], vintageQualities: [] }), profile: unknown = null, quotes: any[] = []) {
  const prisma = {
    producerProfile: { findUnique: jest.fn(async () => profile) },
    $queryRaw: jest.fn(async () => rows),
    photo: { findFirst: jest.fn(async () => photo) },
    movement: { findMany: jest.fn(async () => []) },
    priceQuote: { findMany: jest.fn(async () => quotes) },
    wine: { updateMany: jest.fn(async ({ where }: any) => ({ count: rows.some((r) => r.id === where.id && where.caveId === 'c1') ? 1 : 0 })) },
  };
  return Object.assign(new CaveService(prisma as any, { load: async () => rules } as any, new LocationsService(prisma as any)), { mockPrisma: prisma });
}

describe('CaveService.exitCandidates', () => {
  it('répond 404 pour une photo inconnue', async () => {
    await expect(service(null).exitCandidates('c1', 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ne cherche la photo et les vins en stock que dans la cave', async () => {
    const s = service({ status: 'DONE', purpose: 'EXIT', rawExtraction: raw(2019) });
    await s.exitCandidates('c1', 'p');
    expect(s.mockPrisma.photo.findFirst).toHaveBeenCalledWith({ where: { id: 'p', caveId: 'c1' } });
    expect(s.mockPrisma.$queryRaw.mock.calls[0]).toContain('c1');
  });

  it('dit que l’analyse est en cours tant que la photo n’est pas lue', async () => {
    expect(await service({ status: 'PROCESSING' }).exitCandidates('c1', 'p')).toEqual({ status: 'PROCESSING' });
  });

  it('transmet l’échec de l’analyse', async () => {
    expect(await service({ status: 'FAILED', errorMessage: 'saturé' }).exitCandidates('c1', 'p')).toEqual({ status: 'FAILED', errorMessage: 'saturé' });
  });

  it('classe les vins en stock et renvoie ce que le modèle a lu', async () => {
    const r = await service({ status: 'DONE', purpose: 'EXIT', rawExtraction: raw(2019) }).exitCandidates('c1', 'p');
    expect(r).toMatchObject({ status: 'DONE', outcome: 'UNIQUE', read: { producer: 'Domaine Tempier', vintage: 2019 } });
    expect((r as any).candidates[0].wine.id).toBe('w19');
    expect((r as any).candidates[0].referencePhotoId).toBe('ref19');
  });

  it('fonctionne aussi sur une photo d’entrée réutilisée par la déduplication', async () => {
    const r = await service({ status: 'DONE', purpose: 'ENTRY', rawExtraction: raw(2019) }).exitCandidates('c1', 'p');
    expect((r as any).outcome).toBe('UNIQUE');
  });

  it('traite une extraction illisible comme un échec, jamais comme un vin', async () => {
    expect(await service({ status: 'DONE', rawExtraction: { n: 'importe quoi' } }).exitCandidates('c1', 'p')).toEqual({
      status: 'FAILED',
      errorMessage: 'Lecture de l’étiquette inexploitable',
    });
  });
});

describe('CaveService.detail', () => {
  describe('cote iDealwine', () => {
    const quote = (coteCents: number, quotedOn: string, createdAt: string, sourceUrl: string | null = null) => ({
      wineId: 'w19', coteCents, nTransactions: 12, quotedOn: new Date(`${quotedOn}T00:00:00Z`), sourceUrl, createdAt: new Date(createdAt),
      enteredBy: { displayName: null, email: 'franck@example.com' },
    });
    const search = 'https://www.idealwine.com/fr/prix-vin/domaine-tempier-la-tourtine-2019/le_marche_search/ok_results.jsp';

    it('propriétaire sans cote : quote null et lien de recherche', async () => {
      const s = service(null);
      const r = await s.detail('c1', 'w19', 'OWNER');
      expect(r).toMatchObject({ quote: null, idealwineUrl: search });
      expect(s.mockPrisma.priceQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { wineId: 'w19' } }));
    });

    it('propriétaire : cote courante, valeur de cession, lien enregistré de la cote courante', async () => {
      const page = 'https://www.idealwine.com/fr/acheter-vin/tempier.jsp';
      const r = await service(null, [tempier19], undefined, null, [
        quote(9000, '2025-01-01', '2026-01-01T00:00:00Z', 'https://www.idealwine.com/fr/ancienne.jsp'),
        quote(8500, '2026-03-03', '2026-03-04T00:00:00Z', page),
      ]).detail('c1', 'w19', 'OWNER');
      expect(r.quote).toEqual({ coteCents: 8500, nTransactions: 12, quotedOn: '2026-03-03', sourceUrl: page, enteredBy: 'franck@example.com', cessionCents: 7140 });
      expect(r.idealwineUrl).toBe(page);
      const noUrl = await service(null, [tempier19], undefined, null, [quote(8500, '2026-03-03', '2026-03-04T00:00:00Z')]).detail('c1', 'w19', 'OWNER');
      expect(noUrl.idealwineUrl).toBe(search);
    });

    it('membre : ni quote ni idealwineUrl (clés absentes), cotes non lues', async () => {
      const s = service(null, [tempier19], undefined, null, [quote(8500, '2026-03-03', '2026-03-04T00:00:00Z')]);
      const r = await s.detail('c1', 'w19', 'VIEWER');
      expect(r).not.toHaveProperty('quote');
      expect(r).not.toHaveProperty('idealwineUrl');
      expect(JSON.stringify(r)).not.toMatch(/quote|cote|idealwine|cession/i);
      expect(s.mockPrisma.priceQuote.findMany).not.toHaveBeenCalled();
      expect(await s.detail('c1', 'w19')).not.toHaveProperty('quote');
    });
  });

  it('lit les vins de la cave seulement (cave passée à la requête)', async () => {
    const s = service(null);
    await s.list('c1', {});
    expect(s.mockPrisma.$queryRaw.mock.calls[0]).toContain('c1');
  });

  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, []).detail('c1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('renvoie le vin avec son stock et ses derniers mouvements', async () => {
    const r = await service(null).detail('c1', 'w19');
    expect(r.wine).toMatchObject(tempier19);
    expect(r.movements).toEqual([]);
  });

  it('expose la provenance de la vignette venue du web (null pour une photo de l’utilisateur)', async () => {
    const own = await service(null).detail('c1', 'w19');
    expect(own.wine).toMatchObject({ referencePhotoSource: null, referencePhotoSourceUrl: null });
    const web = { ...tempier19, referencePhotoSource: 'Open Food Facts (CC BY-SA)', referencePhotoSourceUrl: 'https://world.openfoodfacts.org/product/1' };
    const r = await service(null, [web]).detail('c1', 'w19');
    expect(r.wine).toMatchObject({ referencePhotoSource: 'Open Food Facts (CC BY-SA)', referencePhotoSourceUrl: 'https://world.openfoodfacts.org/product/1' });
  });

  it('la liste de la cave ne porte pas la provenance (réservée à la fiche)', async () => {
    const web = { ...tempier19, referencePhotoSource: 'tempier.fr', referencePhotoSourceUrl: 'https://tempier.fr/' };
    const [item] = await service(null, [web]).list('c1', {});
    expect(item).not.toHaveProperty('referencePhotoSource');
    expect(item).not.toHaveProperty('referencePhotoSourceUrl');
  });
});

const cdp = {
  id: 'w16', producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016,
  color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
  appellationId: 'a-cdp', region: 'Rhône', referenceGuardMin: 8, referenceGuardMax: 20, apogeeMin: null, apogeeMax: null, apogeeSource: null,
};

describe('CaveService — apogée', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(new Date('2026-06-01')));
  afterAll(() => jest.useRealTimers());

  it('calcule l’apogée de chaque vin de la liste', async () => {
    const [item] = await service(null, [cdp]).list('c1', {});
    expect(item.apogee).toEqual({ min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' });
  });

  it('n’expose pas les champs internes du calcul', async () => {
    const [item] = await service(null, [cdp]).list('c1', {});
    expect(item).not.toHaveProperty('referenceGuardMin');
    expect(item).not.toHaveProperty('apogeeSource');
    expect(item).not.toHaveProperty('region');
  });

  it('applique immédiatement une règle modifiée (aucun cache entre deux requêtes)', async () => {
    const loads = [
      compileApogeeRules({ guardOverrides: [], vintageQualities: [] }),
      compileApogeeRules({ guardOverrides: [], vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] }),
    ];
    const prisma = {
      $queryRaw: jest.fn(async () => [cdp]), movement: { findMany: jest.fn(async () => []) },
      producerProfile: { findUnique: jest.fn(async () => null) },
    };
    const s = new CaveService(prisma as any, { load: async () => loads.shift()! } as any, new LocationsService(prisma as any));
    expect((await s.detail('c1', 'w16')).wine.apogee).toMatchObject({ min: 2024, max: 2036 });
    expect((await s.detail('c1', 'w16')).wine.apogee).toMatchObject({ min: 2026, max: 2040, confidence: 'MOYENNE' });
  });

  it('montre la correction manuelle, même pour un vin non millésimé', async () => {
    const nv = { ...cdp, vintage: null, apogeeMin: 2027, apogeeMax: 2029, apogeeSource: 'MANUEL' };
    expect((await service(null, [nv]).detail('c1', 'w16')).wine.apogee).toMatchObject({ min: 2027, max: 2029, confidence: 'SAISIE' });
  });

  it('rend les accords du vin sur la fiche, et null sans accords', async () => {
    const withPairing = { ...cdp, pairingStatus: 'DONE', pairingDishes: ['Agneau'], pairingError: null, pairingGeneratedAt: new Date('2026-10-05T10:00:00Z') };
    expect((await service(null, [withPairing]).detail('c1', 'w16')).wine.pairing).toEqual({
      status: 'DONE', dishes: ['Agneau'], errorMessage: null, generatedAt: new Date('2026-10-05T10:00:00Z'),
    });
    expect((await service(null, [cdp]).detail('c1', 'w16')).wine.pairing).toBeNull();
  });

  it('rend le descriptif du domaine sur la fiche, retrouvé par la clé normalisée du producteur', async () => {
    const generatedAt = new Date('2026-10-05T10:00:00Z');
    const profile = {
      id: 'p1', producerKey: 'chateau de beaucastel', displayName: 'Château de Beaucastel', status: 'DONE', description: 'Texte',
      source: 'MANUEL', model: null, costCents: null, errorMessage: null, generatedAt, updatedById: 'u1',
      updatedBy: { displayName: 'Franck', email: 'franck@example.com' }, updatedAt: generatedAt,
    };
    const s = service(null, [cdp], undefined, profile);
    expect((await s.detail('c1', 'w16')).wine.producerProfile).toEqual({
      key: 'chateau de beaucastel', displayName: 'Château de Beaucastel', status: 'DONE', description: 'Texte',
      source: 'MANUEL', errorMessage: null, generatedAt, updatedBy: 'Franck',
    });
    expect(s.mockPrisma.producerProfile.findUnique).toHaveBeenCalledWith({
      where: { producerKey: 'chateau de beaucastel' },
      include: { updatedBy: { select: { displayName: true, email: true } } },
    });
  });

  it('pour un membre (VIEWER), l’auteur du descriptif est son nom affiché ou null, jamais un e-mail', async () => {
    const profile = {
      producerKey: 'chateau de beaucastel', displayName: 'Château de Beaucastel', status: 'DONE', description: 'Texte', source: 'MANUEL',
      errorMessage: null, generatedAt: null, updatedBy: { displayName: null, email: 'franck@example.com' },
    };
    expect((await service(null, [cdp], undefined, profile).detail('c1', 'w16', 'VIEWER')).wine.producerProfile).toMatchObject({ updatedBy: null });
    const named = { ...profile, updatedBy: { displayName: 'Franck', email: 'franck@example.com' } };
    expect((await service(null, [cdp], undefined, named).detail('c1', 'w16', 'VIEWER')).wine.producerProfile).toMatchObject({ updatedBy: 'Franck' });
  });

  it('nomme l’auteur par son e-mail à défaut de nom, et rend null sans descriptif', async () => {
    const profile = {
      producerKey: 'chateau de beaucastel', displayName: 'Château de Beaucastel', status: 'DONE', description: 'Texte', source: 'MANUEL',
      errorMessage: null, generatedAt: null, updatedBy: { displayName: null, email: 'franck@example.com' },
    };
    expect((await service(null, [cdp], undefined, profile).detail('c1', 'w16', 'OWNER')).wine.producerProfile).toMatchObject({ updatedBy: 'franck@example.com' });
    const generated = { ...profile, source: 'GEMINI', updatedBy: null };
    expect((await service(null, [cdp], undefined, generated).detail('c1', 'w16')).wine.producerProfile).toMatchObject({ updatedBy: null });
    expect((await service(null, [cdp]).detail('c1', 'w16')).wine.producerProfile).toBeNull();
  });

  it('expose toujours la clé du domaine, même sans descriptif, et null pour un nom sans lettre ni chiffre', async () => {
    expect((await service(null, [cdp]).detail('c1', 'w16')).wine.producerKey).toBe('chateau de beaucastel');
    const s = service(null, [{ ...cdp, producer: ' — ' }]);
    const { wine } = await s.detail('c1', 'w16');
    expect(wine.producerKey).toBeNull();
    expect(wine.producerProfile).toBeNull();
    expect(s.mockPrisma.producerProfile.findUnique).not.toHaveBeenCalled();
  });

  describe('filtres d’apogée', () => {
    // Châteauneuf 2016 garde 8-20 → fin 2036 ; 2006 → fin 2026 ; 2007 → 2027 ; 2008 → 2028.
    const at = (id: string, vintage: number | null, producer = 'P') => ({ ...cdp, id, vintage, producer });
    // La requête réelle trie par producteur ; le faux renvoie les lignes telles quelles : l'ordre
    // ci-dessous joue ce rôle, et les ex æquo (fin 2027) doivent le garder.
    const rows = [at('v08', 2008), at('v07b', 2007, 'B'), at('v16', 2016), at('nv', null), at('v06', 2006), at('v07', 2007, 'A')];

    it('« à boire en priorité » garde les fins d’apogée jusqu’à l’an prochain, la plus proche en premier', async () => {
      const items = await service(null, rows).list('c1', { drinkSoon: true });
      expect(items.map((i) => i.id)).toEqual(['v06', 'v07b', 'v07']);
    });

    it('« sans apogée » ne garde que les vins sans estimation', async () => {
      const items = await service(null, rows).list('c1', { noApogee: true });
      expect(items.map((i) => i.id)).toEqual(['nv']);
      expect(items[0].apogee.reason).toBe('NON_MILLESIME');
    });

    it('se combine avec la recherche et ignore les vins épuisés', async () => {
      const r = [...rows, { ...at('vide', 2006), quantity: 0 }];
      expect((await service(null, r).list('c1', { drinkSoon: true, q: 'b' })).map((i) => i.id)).toEqual(['v07b']);
    });
  });

  it('enregistre une correction manuelle', async () => {
    const s = service(null, [cdp]);
    await s.setManualApogee('c1', 'w16', { min: 2030, max: 2035 });
    expect((s as any).prisma.wine.updateMany).toHaveBeenCalledWith({ where: { id: 'w16', caveId: 'c1' }, data: { apogeeMin: 2030, apogeeMax: 2035, apogeeSource: 'MANUEL' } });
  });

  it('retire la correction manuelle', async () => {
    const s = service(null, [cdp]);
    await s.clearManualApogee('c1', 'w16');
    expect((s as any).prisma.wine.updateMany).toHaveBeenCalledWith({ where: { id: 'w16', caveId: 'c1' }, data: { apogeeMin: null, apogeeMax: null, apogeeSource: null } });
  });

  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, [cdp]).setManualApogee('c1', 'nope', { min: 2030, max: 2035 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cherche par plat, à boire en priorité d’abord, et dit quel plat correspond', async () => {
    const at = (id: string, vintage: number, producer: string, dishes: string[] | null) => ({ ...cdp, id, vintage, producer, pairingDishes: dishes });
    const rows = [
      at('young', 2016, 'A', ['Gigot d’agneau']),       // fin 2036
      at('none', 2016, 'B', null),
      at('soon', 2006, 'C', ['Agneau de sept heures']), // fin 2026
      at('fish', 2006, 'D', ['Bar grillé']),
    ];
    const items = await service(null, rows).list('c1', { dish: 'agneau' });
    expect(items.map((i) => [i.id, i.matchedDish])).toEqual([['soon', 'Agneau de sept heures'], ['young', 'Gigot d’agneau']]);
  });
});

describe('CaveService — note de dégustation', () => {
  it('expose la note avec son auteur, et null pour un vin non noté', async () => {
    const rated = { ...cdp, id: 'r1', rating: 16.5, ratedAt: new Date('2026-10-05T10:00:00Z'), ratedBy: 'Franck' };
    const items = await service(null, [rated, { ...cdp, id: 'r2' }]).list('c1', {});
    expect(items.find((i) => i.id === 'r1')!.rating).toEqual({ value: 16.5, ratedAt: new Date('2026-10-05T10:00:00Z'), ratedBy: 'Franck' });
    expect(items.find((i) => i.id === 'r2')!.rating).toBeNull();
    expect(items[0]).not.toHaveProperty('ratedAt');
    expect(items[0]).not.toHaveProperty('pairingDishes');
  });

  it('enregistre la note avec la date et l’auteur', async () => {
    const s = service(null, [cdp]);
    await s.setRating('c1', 'w16', 16.5, 'u1');
    expect((s as any).prisma.wine.updateMany).toHaveBeenCalledWith({
      where: { id: 'w16', caveId: 'c1' }, data: { rating: 16.5, ratedAt: expect.any(Date), ratedById: 'u1' },
    });
  });

  it('retire la note', async () => {
    const s = service(null, [cdp]);
    expect(await s.clearRating('c1', 'w16')).toBeNull();
    expect((s as any).prisma.wine.updateMany).toHaveBeenCalledWith({ where: { id: 'w16', caveId: 'c1' }, data: { rating: null, ratedAt: null, ratedById: null } });
  });

  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, [cdp]).setRating('c1', 'nope', 12, 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
