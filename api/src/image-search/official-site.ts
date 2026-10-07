import { Logger } from '@nestjs/common';
import { SAFE_FETCH_TIMEOUT_MS, safeFetch } from './safe-fetch';
import { Fetcher, isHttpUrl, MAX_IMAGES_PER_SOURCE, RemoteImage } from './types';

const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const logger = new Logger('OfficialSite');

/** Mots trop génériques pour reconnaître une image du vin sur le site. */
const GENERIC_WORDS = new Set([
  'domaine', 'domaines', 'chateau', 'chateaux', 'maison', 'cuvee', 'clos', 'cave', 'caves', 'cellier', 'vins', 'vignobles',
  'vignoble', 'famille', 'freres', 'grand', 'earl', 'gaec', 'sarl', 'scea',
]);

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Mots d'au moins 4 lettres du domaine et de la cuvée, sans accents, sans mots génériques ni doublons. */
export function keywordsOf(wine: { producer: string; cuvee: string | null }): string[] {
  const words = fold(`${wine.producer} ${wine.cuvee ?? ''}`).split(/[^a-z0-9]+/);
  return [...new Set(words.filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w)))];
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function attributesOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim());
  }
  return attrs;
}

function absolute(value: string | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base).toString();
    return isHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function fileNameOf(url: string): string {
  const last = new URL(url).pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const OG_KEYS = new Set(['og:image', 'og:image:url', 'og:image:secure_url']);
const TWITTER_KEYS = new Set(['twitter:image', 'twitter:image:src']);

/**
 * Images d'une page du site officiel, dans l'ordre : `og:image`, `twitter:image`,
 * puis les `<img>` dont le texte alternatif ou le nom de fichier contient un mot
 * du domaine ou de la cuvée. Adresses rendues absolues, http(s) seulement, sans
 * doublon, 5 au plus.
 */
export function extractImageUrls(html: string, baseUrl: string, keywords: string[]): string[] {
  const og: string[] = [];
  const twitter: string[] = [];
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributesOf(tag);
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const url = absolute(attrs.get('content'), baseUrl);
    if (!url) continue;
    if (OG_KEYS.has(key)) og.push(url);
    else if (TWITTER_KEYS.has(key)) twitter.push(url);
  }

  const named: string[] = [];
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = attributesOf(tag);
    // Images chargées à la demande : la vraie adresse est souvent dans data-src.
    const url = ['src', 'data-src', 'data-lazy-src', 'data-original'].map((k) => absolute(attrs.get(k), baseUrl)).find(Boolean);
    if (!url) continue;
    const haystack = fold(`${attrs.get('alt') ?? ''} ${fileNameOf(url)}`);
    if (keywords.some((w) => haystack.includes(w))) named.push(url);
  }

  return [...new Set([...og, ...twitter, ...named])].slice(0, MAX_IMAGES_PER_SOURCE);
}

/**
 * Lit la page du site officiel (2 Mo au plus : au-delà, le début suffit, les
 * balises og:image sont dans l'en-tête) et en tire les images proposées, en 8 s
 * au plus et jamais au-delà du délai global de la recherche (`signal`). Site
 * injoignable, refusé ou qui n'est pas une page HTML : liste vide.
 */
export async function readOfficialSiteImages(
  site: string,
  wine: { producer: string; cuvee: string | null },
  fetcher: Fetcher = safeFetch,
  signal?: AbortSignal,
): Promise<RemoteImage[]> {
  let page;
  try {
    page = await fetcher(site, {
      maxBytes: PAGE_MAX_BYTES,
      overflow: 'truncate',
      timeoutMs: SAFE_FETCH_TIMEOUT_MS,
      signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (e) {
    logger.warn(`Site officiel illisible (${site}) : ${(e as Error).message}`);
    return [];
  }
  if (page.contentType && !/html/i.test(page.contentType)) return [];
  const source = new URL(page.finalUrl).hostname.replace(/^www\./, '');
  return extractImageUrls(page.buffer.toString('utf8'), page.finalUrl, keywordsOf(wine)).map((imageUrl) => ({
    imageUrl,
    source,
    sourceUrl: page.finalUrl,
  }));
}
