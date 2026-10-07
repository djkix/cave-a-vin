import { OFF_SOURCE, searchOpenFoodFacts, USER_AGENT } from './open-food-facts';

const wine = { producer: 'Domaine Tempier', cuvee: 'La Migoua', appellation: 'Bandol' };

function fetcherReturning(body: unknown) {
  return jest.fn(async (url: string) => ({ buffer: Buffer.from(JSON.stringify(body)), contentType: 'application/json', finalUrl: url }));
}

const product = (code: string, categories: string[] = ['en:beverages', 'en:wines'], image: string | undefined = `https://images.openfoodfacts.org/images/products/${code}/front_fr.jpg`) => ({
  code, categories_tags: categories, image_front_url: image,
});

describe('searchOpenFoodFacts', () => {
  it('cherche « producteur cuvée appellation » avec le User-Agent du projet', async () => {
    const fetcher = fetcherReturning({ products: [] });
    await searchOpenFoodFacts(wine, fetcher);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://world.openfoodfacts.org/cgi/search.pl');
    expect(parsed.searchParams.get('search_terms')).toBe('Domaine Tempier La Migoua Bandol');
    expect(parsed.searchParams.get('json')).toBe('1');
    expect(options.headers['User-Agent']).toBe(USER_AGENT);
  });

  it('le User-Agent nomme l’application et l’adresse du dépôt, sans fausse version', () => {
    // api/package.json reste à 0.0.0 (la version vit dans le manifeste racine) : ne pas l'annoncer.
    expect(USER_AGENT).toBe('CaveEtTerroir (+https://github.com/djkix/cave-a-vin)');
  });

  it('omet la cuvée absente', async () => {
    const fetcher = fetcherReturning({ products: [] });
    await searchOpenFoodFacts({ ...wine, cuvee: null }, fetcher);
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('search_terms')).toBe('Domaine Tempier Bandol');
  });

  it('ne garde que les vins avec une image de face, et cite la source', async () => {
    const fetcher = fetcherReturning({
      products: [
        product('111'),
        product('222', ['en:beverages', 'en:beers']),
        { code: '333', categories_tags: ['en:wines'], image_front_url: null },
        { code: '444', image_front_url: 'https://images.openfoodfacts.org/444.jpg' },
        product('555', ['en:red-wines', 'en:wines']),
      ],
    });
    const r = await searchOpenFoodFacts(wine, fetcher);
    expect(r).toEqual([
      { imageUrl: 'https://images.openfoodfacts.org/images/products/111/front_fr.jpg', source: OFF_SOURCE, sourceUrl: 'https://world.openfoodfacts.org/product/111' },
      { imageUrl: 'https://images.openfoodfacts.org/images/products/555/front_fr.jpg', source: OFF_SOURCE, sourceUrl: 'https://world.openfoodfacts.org/product/555' },
    ]);
    expect(OFF_SOURCE).toBe('Open Food Facts (CC BY-SA)');
  });

  it('rend au plus 5 images', async () => {
    const fetcher = fetcherReturning({ products: Array.from({ length: 9 }, (_, i) => product(String(1000 + i))) });
    expect(await searchOpenFoodFacts(wine, fetcher)).toHaveLength(5);
  });

  it('ignore une image qui n’est pas en http(s)', async () => {
    const fetcher = fetcherReturning({ products: [product('1', ['en:wines'], 'javascript:alert(1)'), product('2', ['en:wines'], 'file:///etc/passwd')] });
    expect(await searchOpenFoodFacts(wine, fetcher)).toEqual([]);
  });

  it('rend une liste vide sur erreur réseau', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await searchOpenFoodFacts(wine, fetcher)).toEqual([]);
  });

  it('rend une liste vide sur une réponse illisible', async () => {
    const fetcher = jest.fn(async (url: string) => ({ buffer: Buffer.from('<html>panne</html>'), contentType: 'text/html', finalUrl: url }));
    expect(await searchOpenFoodFacts(wine, fetcher)).toEqual([]);
    expect(await searchOpenFoodFacts(wine, fetcherReturning({ products: 'non' }))).toEqual([]);
  });
});
