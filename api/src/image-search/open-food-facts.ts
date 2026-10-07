import { Logger } from '@nestjs/common';
import { safeFetch } from './safe-fetch';
import { Fetcher, ImageSearchWine, isHttpUrl, MAX_IMAGES_PER_SOURCE, RemoteImage } from './types';

export const OFF_SOURCE = 'Open Food Facts (CC BY-SA)';
const OFF_ORIGIN = 'https://world.openfoodfacts.org';
const OFF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Open Food Facts demande un User-Agent qui identifie l'application et un contact.
 * Sans numéro de version : `api/package.json` reste à 0.0.0 (la version vit dans le
 * manifeste racine), mieux vaut ne rien annoncer qu'une fausse version.
 */
export const USER_AGENT = 'CaveEtTerroir (+https://github.com/djkix/cave-a-vin)';

const logger = new Logger('OpenFoodFacts');

interface OffProduct {
  code?: unknown;
  categories_tags?: unknown;
  image_front_url?: unknown;
}

/**
 * Recherche texte sur Open Food Facts : au plus 5 images de face de produits
 * classés vins. Une panne (réseau, réponse illisible) rend une liste vide : la
 * recherche passe alors au site officiel.
 */
export async function searchOpenFoodFacts(wine: ImageSearchWine, fetcher: Fetcher = safeFetch): Promise<RemoteImage[]> {
  const terms = [wine.producer, wine.cuvee, wine.appellation].map((s) => s?.trim()).filter(Boolean).join(' ');
  const url = new URL('/cgi/search.pl', OFF_ORIGIN);
  url.searchParams.set('search_terms', terms);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', '24');
  url.searchParams.set('fields', 'code,categories_tags,image_front_url');

  let products: unknown;
  try {
    const res = await fetcher(url.toString(), { maxBytes: OFF_MAX_BYTES, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    products = (JSON.parse(res.buffer.toString('utf8')) as { products?: unknown }).products;
  } catch (e) {
    logger.warn(`Recherche Open Food Facts impossible : ${(e as Error).message}`);
    return [];
  }
  if (!Array.isArray(products)) return [];

  const images: RemoteImage[] = [];
  const seen = new Set<string>();
  for (const p of products as OffProduct[]) {
    if (images.length >= MAX_IMAGES_PER_SOURCE) break;
    if (!p || !Array.isArray(p.categories_tags) || !p.categories_tags.includes('en:wines')) continue;
    if (!isHttpUrl(p.image_front_url) || seen.has(p.image_front_url)) continue;
    if (typeof p.code !== 'string' && typeof p.code !== 'number') continue;
    seen.add(p.image_front_url);
    images.push({
      imageUrl: p.image_front_url,
      source: OFF_SOURCE,
      sourceUrl: `${OFF_ORIGIN}/product/${encodeURIComponent(String(p.code))}`,
    });
  }
  return images;
}
