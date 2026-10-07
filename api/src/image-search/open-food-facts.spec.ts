import { OFF_SOURCE, searchOpenFoodFacts, USER_AGENT } from './open-food-facts';

const wine = { producer: 'Domaine Tempier', cuvee: 'La Migoua', appellation: 'Bandol', vintage: 2019 };
const SEARCH = 'https://search.openfoodfacts.org/search';
const LEGACY = 'https://world.openfoodfacts.org/cgi/search.pl';

const img = (code: string) => `https://images.openfoodfacts.org/images/products/${code}/front_fr.jpg`;
const hit = (code: string, product_name: string, brands: string | string[] = [], categories: string[] = ['en:beverages', 'en:wines'], image: string | null = img(code)) => ({
  code, product_name, brands, categories_tags: categories, image_front_url: image,
});

/** Réponse de search.openfoodfacts.org : `{ count, hits }`. */
const searchBody = (hits: unknown[]) => ({ count: hits.length, hits, page: 1, page_size: 20, is_count_exact: true });
/** Réponse de l'ancien cgi/search.pl : `{ count, products }`. */
const legacyBody = (products: unknown[]) => ({ count: products.length, page: 1, page_size: 24, products });

type Reply = { status?: number; body: unknown; type?: string } | Error;

/** Réseau simulé : comme safeFetch, une réponse non 2xx lève une erreur. */
function network(search: Reply, legacy: Reply = new Error('ne devrait pas être appelé')) {
  return jest.fn(async (url: string) => {
    const reply = url.startsWith(SEARCH) ? search : url.startsWith(LEGACY) ? legacy : new Error(`inattendu ${url}`);
    if (reply instanceof Error) throw reply;
    if (reply.status && reply.status !== 200) throw new Error(`Téléchargement refusé : réponse HTTP ${reply.status}`);
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return { buffer: Buffer.from(text), contentType: reply.type ?? 'application/json', finalUrl: url };
  });
}

const TEMPIER = hit('3760', 'Domaine Tempier Bandol rouge', ['Domaine Tempier']);
const KIRKLAND = hit('0961', 'Natures Domain', 'Kirkland Signature');
const BOUSQUET = hit('7798', 'Malbec Reserve', ['Domaine Bousquet']);

describe('searchOpenFoodFacts — service de recherche', () => {
  it('interroge search.openfoodfacts.org avec le User-Agent du projet, en JSON', async () => {
    const fetcher = network({ body: searchBody([]) });
    await searchOpenFoodFacts(wine, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, { headers: Record<string, string>; maxBytes: number }];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(SEARCH);
    expect(parsed.searchParams.get('q')).toBe('Domaine Tempier La Migoua Bandol');
    expect(parsed.searchParams.get('page_size')).toBe('20');
    expect(parsed.searchParams.get('fields')).toBe('product_name,brands,image_front_url,categories_tags,code');
    expect(options.headers['User-Agent']).toBe(USER_AGENT);
    expect(options.headers.Accept).toBe('application/json');
    expect(options.maxBytes).toBe(2 * 1024 * 1024);
  });

  it('le User-Agent nomme l’application et l’adresse du dépôt, sans fausse version', () => {
    expect(USER_AGENT).toBe('CaveEtTerroir (+https://github.com/djkix/cave-a-vin)');
  });

  it('garde « Domaine Tempier Bandol rouge » et rejette les résultats flous (Kirkland, Domaine Bousquet)', async () => {
    const r = await searchOpenFoodFacts(wine, network({ body: searchBody([KIRKLAND, BOUSQUET, TEMPIER]) }));
    expect(r).toEqual([{ imageUrl: img('3760'), source: OFF_SOURCE, sourceUrl: 'https://world.openfoodfacts.org/product/3760' }]);
  });

  it('cherche le producteur dans le nom ou la marque (chaîne ou liste)', async () => {
    const byBrand = hit('1', 'Bandol rouge 2019', 'Tempier');
    const byBrandList = hit('2', 'Rosé', ['SCEA', 'Domaine Tempier']);
    const r = await searchOpenFoodFacts(wine, network({ body: searchBody([byBrand, byBrandList]) }));
    expect(r.map((i) => i.imageUrl)).toEqual([img('1'), img('2')]);
  });

  it('rejette un produit qui n’est pas un vin, ou sans image de face', async () => {
    const jus = hit('10', 'Jus de raisin Tempier', [], ['en:beverages', 'en:fruit-juices']);
    const sansImage = hit('11', 'Domaine Tempier Bandol', [], ['en:wines'], null);
    const sansCategories = { code: '12', product_name: 'Domaine Tempier', image_front_url: img('12') };
    const pasHttp = hit('13', 'Domaine Tempier', [], ['en:wines'], 'javascript:alert(1)');
    expect(await searchOpenFoodFacts(wine, network({ body: searchBody([jus, sansImage, sansCategories, pasHttp]) }))).toEqual([]);
  });

  it('exige chaque mot significatif du producteur (≥ 4 lettres, hors domaine/château/maison…)', async () => {
    const chateau = { producer: 'Château de Beaucastel', cuvee: null, appellation: 'Châteauneuf-du-Pape', vintage: null };
    const ok = hit('20', 'Chateau de Beaucastel Chateauneuf du Pape', []);
    const autreChateau = hit('21', 'Château Mont-Redon Châteauneuf-du-Pape', []);
    const r = await searchOpenFoodFacts(chateau, network({ body: searchBody([autreChateau, ok]) }));
    expect(r.map((i) => i.imageUrl)).toEqual([img('20')]);
  });

  it('sans mot significatif, exige le nom complet du producteur', async () => {
    const court = { producer: 'Clos du Roy', cuvee: null, appellation: 'Bordeaux', vintage: null };
    const ok = hit('30', 'Clos du Roy Bordeaux rouge', []);
    const presque = hit('31', 'Clos Roy', []);
    const autre = hit('32', 'Roy rosé', ['Clos du Moulin']);
    const r = await searchOpenFoodFacts(court, network({ body: searchBody([presque, autre, ok]) }));
    expect(r.map((i) => i.imageUrl)).toEqual([img('30')]);
  });

  it('place d’abord les résultats qui portent aussi l’appellation ou le millésime', async () => {
    const plain = hit('40', 'Tempier rosé', []);
    const withYear = hit('41', 'Tempier 2019', []);
    const withAppellation = hit('42', 'Tempier Bandol', []);
    const r = await searchOpenFoodFacts(wine, network({ body: searchBody([plain, withYear, withAppellation]) }));
    expect(r.map((i) => i.imageUrl)).toEqual([img('41'), img('42'), img('40')]);
  });

  it('rend au plus 5 images, sans doublon', async () => {
    const hits = Array.from({ length: 9 }, (_, i) => hit(String(100 + i), `Domaine Tempier Bandol ${i}`, []));
    const r = await searchOpenFoodFacts(wine, network({ body: searchBody([hits[0], hits[0], ...hits]) }));
    expect(r.map((i) => i.imageUrl)).toEqual(['100', '101', '102', '103', '104'].map(img));
  });

  it('une réponse sans résultat pertinent ne déclenche pas l’ancienne recherche', async () => {
    const fetcher = network({ body: searchBody([KIRKLAND]) });
    expect(await searchOpenFoodFacts(wine, fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('searchOpenFoodFacts — repli sur l’ancienne recherche', () => {
  const htmlDown = '<!DOCTYPE html><html><head><title>Page temporarily unavailable</title></head><body>Page temporarily unavailable</body></html>';

  it.each<[string, Reply]>([
    ['une erreur 503', { status: 503, body: htmlDown, type: 'text/html' }],
    ['une page HTML', { body: htmlDown, type: 'text/html' }],
    ['un JSON sans « hits »', { body: { error: 'oops' } }],
    ['une panne réseau', new Error('ECONNRESET')],
  ])('après %s du service de recherche, interroge cgi/search.pl une fois', async (_label, search) => {
    const fetcher = network(search, { body: legacyBody([KIRKLAND, TEMPIER]) });
    const r = await searchOpenFoodFacts(wine, fetcher);
    expect(r).toEqual([{ imageUrl: img('3760'), source: OFF_SOURCE, sourceUrl: 'https://world.openfoodfacts.org/product/3760' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[1] as unknown as [string, { headers: Record<string, string> }];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(LEGACY);
    expect(parsed.searchParams.get('search_terms')).toBe('Domaine Tempier La Migoua Bandol');
    expect(parsed.searchParams.get('json')).toBe('1');
    expect(parsed.searchParams.get('fields')).toContain('product_name');
    expect(options.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('les deux en panne (503 puis page HTML) : liste vide, sans erreur', async () => {
    const fetcher = network({ status: 503, body: htmlDown, type: 'text/html' }, { status: 503, body: htmlDown, type: 'text/html' });
    await expect(searchOpenFoodFacts(wine, fetcher)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const html200 = network(new Error('ETIMEDOUT'), { body: htmlDown, type: 'text/html' });
    await expect(searchOpenFoodFacts(wine, html200)).resolves.toEqual([]);
    await expect(searchOpenFoodFacts(wine, network(new Error('x'), { body: { products: 'non' } }))).resolves.toEqual([]);
  });
});
