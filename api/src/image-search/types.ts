import { safeFetch } from './safe-fetch';

/** Image distante proposée, avant téléchargement. */
export interface RemoteImage {
  imageUrl: string;
  /** Provenance affichée : « Open Food Facts (CC BY-SA) » ou nom de domaine du site. */
  source: string;
  /** Page d'où vient l'image (fiche produit, site du domaine). */
  sourceUrl: string;
}

export interface ImageSearchWine {
  producer: string;
  cuvee: string | null;
  appellation: string;
  /** Millésime : un résultat qui le porte passe devant. */
  vintage?: number | null;
}

/** Signature de `safeFetch`, remplaçable dans les tests. */
export type Fetcher = typeof safeFetch;

/** Nombre maximal d'images proposées par source. */
export const MAX_IMAGES_PER_SOURCE = 5;

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
