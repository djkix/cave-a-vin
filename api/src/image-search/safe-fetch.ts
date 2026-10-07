import { promises as dns } from 'node:dns';
import { request as httpRequest, IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, LookupFunction } from 'node:net';

/**
 * Téléchargement d'une adresse venue d'un tiers (Open Food Facts, site trouvé par
 * Gemini, HTML de ce site) : le serveur ne doit jamais devenir un relais vers le
 * réseau domestique (box, Redis, PostgreSQL, métadonnées d'un hébergeur).
 *
 * - http et https seulement, sans identifiants dans l'adresse ;
 * - le nom est résolu ici (toutes ses adresses) et refusé si l'une d'elles est
 *   privée, de bouclage, link-local, réservée ou multicast ;
 * - la connexion part vers l'adresse vérifiée (épinglée), jamais vers une
 *   seconde résolution qui pourrait répondre autre chose (rebinding DNS) ;
 * - redirections suivies à la main, au plus 3, chacune revérifiée ;
 * - délai global (8 s par défaut) et taille maximale, vérifiée sur l'en-tête puis
 *   pendant la lecture.
 */

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
  /** Libère la connexion (réponse abandonnée avant la fin). */
  close(): void;
}

export type Transport = (
  url: URL,
  pinned: ResolvedAddress,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<RawResponse>;

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** 'truncate' : garder les `maxBytes` premiers octets au lieu de refuser (page HTML). */
  overflow?: 'error' | 'truncate';
  maxRedirects?: number;
  lookup?: LookupFn;
  transport?: Transport;
}

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string | null;
  finalUrl: string;
}

export class SafeFetchError extends Error {}

export const SAFE_FETCH_TIMEOUT_MS = 8000;
export const SAFE_FETCH_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** [réseau, longueur du préfixe] en IPv4. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // « ce réseau »
  ['10.0.0.0', 8], // privé
  ['100.64.0.0', 10], // NAT de l'opérateur
  ['127.0.0.0', 8], // bouclage
  ['169.254.0.0', 16], // link-local (métadonnées des hébergeurs)
  ['172.16.0.0', 12], // privé
  ['192.0.0.0', 24], // réservé IETF
  ['192.168.0.0', 16], // privé
  ['198.18.0.0', 15], // bancs d'essai
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // réservé, diffusion
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([net, len]) => {
    const size = 2 ** (32 - len);
    const start = v4ToInt(net);
    return n >= start && n < start + size;
  });
}

/** Les 8 groupes de 16 bits d'une adresse IPv6 (forme abrégée et IPv4 finale acceptées). */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const n = v4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...rest];
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : groups;
}

function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  // ::ffff:a.b.c.d (IPv4 projetée), ::a.b.c.d (compatible, obsolète), 64:ff9b::a.b.c.d (NAT64) :
  // c'est l'adresse IPv4 embarquée qui compte. `::` et `::1` tombent dans le cas « compatible ».
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0) return true; // ::, ::1 et ::/112
    return v4Blocked(embeddedV4());
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embeddedV4());
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, adresses locales uniques
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10, site-local (obsolète)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Adresse interdite (privée, bouclage, link-local, réservée) ou illisible. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip.split('%')[0]);
  if (family === 4) return v4Blocked(ip);
  if (family === 6) return v6Blocked(ip);
  return true;
}

const systemLookup: LookupFn = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

function headerValue(headers: RawResponse['headers'], name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Transport par défaut : http(s) de Node, avec une résolution remplacée par
 * l'adresse déjà vérifiée. Le nom reste celui de l'adresse (en-tête Host, SNI
 * et vérification du certificat TLS inchangés).
 */
export const nodeTransport: Transport = (url, pinned, init) =>
  new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (err: null, addresses: ResolvedAddress[]) => void)(null, [pinned]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(
      url,
      {
        method: 'GET',
        headers: { 'accept-encoding': 'identity', ...init.headers },
        lookup,
        signal: init.signal,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as IncomingHttpHeaders,
          body: res,
          close: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

async function assertAllowedUrl(url: URL, lookup: LookupFn): Promise<ResolvedAddress> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError(`Téléchargement refusé : schéma ${url.protocol} interdit`);
  if (url.username || url.password) throw new SafeFetchError('Téléchargement refusé : identifiants dans l’adresse');
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!hostname) throw new SafeFetchError('Téléchargement refusé : adresse sans hôte');
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (e) {
    throw new SafeFetchError(`Téléchargement refusé : nom introuvable (${(e as Error).message})`);
  }
  if (addresses.length === 0) throw new SafeFetchError('Téléchargement refusé : nom introuvable');
  if (addresses.some((a) => isBlockedAddress(a.address))) throw new SafeFetchError('Téléchargement refusé : adresse interdite');
  return addresses[0];
}

/** Rejette dès que le signal est levé, même si l'opération attendue l'ignore. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SafeFetchError('Téléchargement abandonné : délai dépassé'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SafeFetchError('Téléchargement abandonné : délai dépassé'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? new SafeFetchError('Téléchargement abandonné : délai dépassé') : e);
      },
    );
  });
}

async function readBody(res: RawResponse, maxBytes: number, overflow: 'error' | 'truncate', signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = res.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await untilAborted(iterator.next(), signal);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      if (total + chunk.length > maxBytes) {
        if (overflow === 'truncate') {
          chunks.push(chunk.subarray(0, maxBytes - total));
          total = maxBytes;
          res.close();
          break;
        }
        throw new SafeFetchError('Téléchargement refusé : contenu trop volumineux');
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch (e) {
    res.close();
    throw e;
  }
  return Buffer.concat(chunks, total);
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const lookup = options.lookup ?? systemLookup;
  const transport = options.transport ?? nodeTransport;
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  const overflow = options.overflow ?? 'error';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS);
  try {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SafeFetchError('Téléchargement refusé : adresse illisible');
    }
    for (let redirects = 0; ; redirects++) {
      const pinned = await untilAborted(assertAllowedUrl(url, lookup), controller.signal);
      const res = await untilAborted(transport(url, pinned, { headers: options.headers ?? {}, signal: controller.signal }), controller.signal);

      if (REDIRECT_STATUSES.has(res.status)) {
        res.close();
        const location = headerValue(res.headers, 'location');
        if (!location) throw new SafeFetchError('Téléchargement refusé : redirection sans destination');
        if (redirects >= maxRedirects) throw new SafeFetchError('Téléchargement refusé : trop de redirections');
        try {
          url = new URL(location, url);
        } catch {
          throw new SafeFetchError('Téléchargement refusé : redirection illisible');
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.close();
        throw new SafeFetchError(`Téléchargement refusé : réponse HTTP ${res.status}`);
      }
      const declared = Number(headerValue(res.headers, 'content-length'));
      if (overflow === 'error' && Number.isFinite(declared) && declared > options.maxBytes) {
        res.close();
        throw new SafeFetchError('Téléchargement refusé : contenu trop volumineux');
      }
      const buffer = await readBody(res, options.maxBytes, overflow, controller.signal);
      return { buffer, contentType: headerValue(res.headers, 'content-type'), finalUrl: url.toString() };
    }
  } finally {
    clearTimeout(timer);
  }
}
