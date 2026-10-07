import { Logger } from '@nestjs/common';
import { normalizeLabel } from '../appellations/appellations.service';
import { safeFetch } from './safe-fetch';
import { Fetcher, ImageSearchWine, isHttpUrl, MAX_IMAGES_PER_SOURCE, RemoteImage } from './types';

export const OFF_SOURCE = 'Open Food Facts (CC BY-SA)';
const OFF_ORIGIN = 'https://world.openfoodfacts.org';
const OFF_SEARCH_ORIGIN = 'https://search.openfoodfacts.org';
const OFF_MAX_BYTES = 2 * 1024 * 1024;
const FIELDS = 'product_name,brands,image_front_url,categories_tags,code';

/**
 * Open Food Facts demande un User-Agent qui identifie l'application et un contact.
 * Sans numéro de version : `api/package.json` reste à 0.0.0 (la version vit dans le
 * manifeste racine), mieux vaut ne rien annoncer qu'une fausse version.
 */
export const USER_AGENT = 'CaveEtTerroir (+https://github.com/djkix/cave-a-vin)';

/** Mots trop courants dans les noms de producteurs pour reconnaître le bon. */
const GENERIC_PRODUCER_WORDS = new Set(['domaine', 'chateau', 'maison', 'clos', 'cave', 'vins']);

const logger = new Logger('OpenFoodFacts');

interface OffProduct {
  code?: unknown;
  product_name?: unknown;
  brands?: unknown;
  categories_tags?: unknown;
  image_front_url?: unknown;
}

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(' ') : '';

async function fetchJson(url: URL, fetcher: Fetcher): Promise<unknown> {
  const res = await fetcher(url.toString(), { maxBytes: OFF_MAX_BYTES, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.contentType && !/json/i.test(res.contentType)) throw new Error(`réponse ${res.contentType} au lieu de JSON`);
  return JSON.parse(res.buffer.toString('utf8'));
}

/** Service de recherche actuel : `{ count, hits }`, stable. */
async function searchService(terms: string, fetcher: Fetcher): Promise<unknown[]> {
  const url = new URL('/search', OFF_SEARCH_ORIGIN);
  url.searchParams.set('q', terms);
  url.searchParams.set('page_size', '20');
  url.searchParams.set('fields', FIELDS);
  const hits = ((await fetchJson(url, fetcher)) as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) throw new Error('réponse sans « hits »');
  return hits;
}

/** Ancienne recherche `cgi/search.pl` : `{ products }`, parfois indisponible (503 en HTML). */
async function legacySearch(terms: string, fetcher: Fetcher): Promise<unknown[]> {
  const url = new URL('/cgi/search.pl', OFF_ORIGIN);
  url.searchParams.set('search_terms', terms);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', '24');
  url.searchParams.set('fields', FIELDS);
  const products = ((await fetchJson(url, fetcher)) as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) throw new Error('réponse sans « products »');
  return products;
}

const hasPhrase = (haystack: string, phrase: string) => phrase !== '' && ` ${haystack} `.includes(` ${phrase} `);

/**
 * Un résultat est retenu s'il nomme le producteur : chaque mot significatif (au
 * moins 4 lettres, hors « domaine », « château »…) dans le nom ou la marque ; à
 * défaut de mot significatif, le nom complet du producteur. La recherche
 * d'Open Food Facts est floue (« Domaine Tempier » y ramène « Natures Domain » ou
 * « Domaine Bousquet ») : sans ce filtre, l'image d'un autre vin serait proposée.
 */
function producerMatcher(producer: string): (haystack: string) => boolean {
  const full = normalizeLabel(producer);
  const words = full.split(' ').filter((w) => w.length >= 4 && !GENERIC_PRODUCER_WORDS.has(w));
  if (words.length === 0) return (haystack) => hasPhrase(haystack, full);
  return (haystack) => {
    const tokens = new Set(haystack.split(' '));
    return words.every((w) => tokens.has(w));
  };
}

/**
 * Recherche texte sur Open Food Facts : au plus 5 images de face de vins qui
 * nomment le producteur, ceux qui portent aussi l'appellation ou le millésime
 * d'abord. Le service de recherche d'abord, l'ancienne recherche une fois en
 * secours ; toute panne rend une liste vide (la recherche passe alors au site
 * officiel), jamais une erreur.
 */
export async function searchOpenFoodFacts(wine: ImageSearchWine, fetcher: Fetcher = safeFetch): Promise<RemoteImage[]> {
  const terms = [wine.producer, wine.cuvee, wine.appellation].map((s) => s?.trim()).filter(Boolean).join(' ');

  let products: unknown[];
  try {
    products = await searchService(terms, fetcher);
  } catch (e) {
    logger.warn(`Service de recherche Open Food Facts indisponible, essai de l'ancienne recherche : ${(e as Error).message}`);
    try {
      products = await legacySearch(terms, fetcher);
    } catch (e2) {
      logger.warn(`Recherche Open Food Facts impossible : ${(e2 as Error).message}`);
      return [];
    }
  }

  const namesProducer = producerMatcher(wine.producer);
  const appellation = normalizeLabel(wine.appellation ?? '');
  const vintage = wine.vintage == null ? null : String(wine.vintage);

  const kept: Array<{ image: RemoteImage; bonus: boolean }> = [];
  const seen = new Set<string>();
  for (const p of products as OffProduct[]) {
    if (!p || !Array.isArray(p.categories_tags) || !p.categories_tags.includes('en:wines')) continue;
    if (!isHttpUrl(p.image_front_url) || seen.has(p.image_front_url)) continue;
    if (typeof p.code !== 'string' && typeof p.code !== 'number') continue;
    const haystack = normalizeLabel(`${textOf(p.product_name)} ${textOf(p.brands)}`);
    if (!namesProducer(haystack)) continue;
    seen.add(p.image_front_url);
    const bonus = hasPhrase(haystack, appellation) || (vintage !== null && haystack.split(' ').includes(vintage));
    kept.push({
      image: { imageUrl: p.image_front_url, source: OFF_SOURCE, sourceUrl: `${OFF_ORIGIN}/product/${encodeURIComponent(String(p.code))}` },
      bonus,
    });
  }
  // Tri stable : l'ordre de pertinence d'Open Food Facts est gardé à bonus égal.
  return [...kept.filter((k) => k.bonus), ...kept.filter((k) => !k.bonus)].slice(0, MAX_IMAGES_PER_SOURCE).map((k) => k.image);
}
