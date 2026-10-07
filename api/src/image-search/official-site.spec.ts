import { extractImageUrls, keywordsOf, readOfficialSiteImages } from './official-site';

const wine = { producer: 'Domaine Tempier', cuvee: 'La Migoua', appellation: 'Bandol' };

const PAGE = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta content="https://cdn.tempier.fr/partage.jpg?v=2&amp;w=1200" property="og:image">
  <meta name="twitter:image" content="/img/twitter-card.png">
  <meta property="og:image" content="https://cdn.tempier.fr/partage.jpg?v=2&amp;w=1200">
  <title>Domaine Tempier</title>
</head><body>
  <img src="/img/logo.svg" alt="Logo">
  <img src="/img/vignes.jpg" alt="Les vignes au printemps">
  <img src="/img/bouteilles/la-migoua-2019.png" alt="">
  <img alt="Bouteille Tempier rouge" src='https://cdn.tempier.fr/b/rouge.webp'>
  <img data-src="/lazy/Migoua_etiquette.jpg" src="data:image/gif;base64,R0lGOD">
  <img src="/img/domaine-chateau.jpg" alt="Le domaine">
  <img src="javascript:alert(1)" alt="Tempier">
  <img src="/img/TEMPIER-cave.jpg">
  <img src="/img/tempier-encore.jpg">
</body></html>`;

describe('keywordsOf', () => {
  it('garde les mots d’au moins 4 lettres du domaine et de la cuvée, sans accents ni mots génériques', () => {
    expect(keywordsOf({ producer: 'Château Pradeaux', cuvee: 'Côte du Rhône Élégance' })).toEqual(['pradeaux', 'cote', 'rhone', 'elegance']);
    expect(keywordsOf({ producer: 'Domaine Tempier', cuvee: 'La Migoua' })).toEqual(['tempier', 'migoua']);
  });
});

describe('extractImageUrls', () => {
  it('prend og:image et twitter:image d’abord, puis les <img> qui nomment le vin, en adresses absolues, 5 au plus', () => {
    const urls = extractImageUrls(PAGE, 'https://www.tempier.fr/vins/', keywordsOf(wine));
    expect(urls).toEqual([
      'https://cdn.tempier.fr/partage.jpg?v=2&w=1200',
      'https://www.tempier.fr/img/twitter-card.png',
      'https://www.tempier.fr/img/bouteilles/la-migoua-2019.png',
      'https://cdn.tempier.fr/b/rouge.webp',
      'https://www.tempier.fr/lazy/Migoua_etiquette.jpg',
    ]);
  });

  it('ignore les images sans rapport avec le vin, les schémas non http(s) et les doublons', () => {
    const html = '<img src="/a.jpg" alt="paysage"><img src="data:image/png;base64,xx" alt="Tempier"><img src="/t.jpg" alt="Tempier"><img src="/t.jpg" alt="Tempier">';
    expect(extractImageUrls(html, 'https://tempier.fr/', ['tempier'])).toEqual(['https://tempier.fr/t.jpg']);
  });

  it('rend une liste vide pour une page sans image', () => {
    expect(extractImageUrls('<html><body>Bonjour</body></html>', 'https://tempier.fr/', ['tempier'])).toEqual([]);
  });
});

describe('readOfficialSiteImages', () => {
  it('lit la page (2 Mo au plus, tronquée) et cite le nom de domaine du site', async () => {
    const fetcher = jest.fn(async () => ({ buffer: Buffer.from(PAGE), contentType: 'text/html; charset=utf-8', finalUrl: 'https://www.tempier.fr/' }));
    const images = await readOfficialSiteImages('https://tempier.fr', wine, fetcher);
    expect(fetcher).toHaveBeenCalledWith('https://tempier.fr', expect.objectContaining({ maxBytes: 2 * 1024 * 1024, overflow: 'truncate' }));
    expect(images).toHaveLength(5);
    expect(images[0]).toEqual({ imageUrl: 'https://cdn.tempier.fr/partage.jpg?v=2&w=1200', source: 'tempier.fr', sourceUrl: 'https://www.tempier.fr/' });
  });

  it('rend une liste vide si le site est injoignable ou n’est pas une page HTML', async () => {
    const down = jest.fn(async () => {
      throw new Error('Téléchargement refusé : adresse interdite');
    });
    expect(await readOfficialSiteImages('https://tempier.fr', wine, down)).toEqual([]);
    const pdf = jest.fn(async () => ({ buffer: Buffer.from(PAGE), contentType: 'application/pdf', finalUrl: 'https://tempier.fr/' }));
    expect(await readOfficialSiteImages('https://tempier.fr', wine, pdf)).toEqual([]);
  });
});
