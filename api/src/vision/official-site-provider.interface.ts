export const OFFICIAL_SITE_PROVIDER = 'OFFICIAL_SITE_PROVIDER';

export interface OfficialSiteQuery {
  producer: string;
  cuvee: string | null;
  appellation: string;
  vintage: number | null;
}

export interface OfficialSiteResult {
  /** Adresse http(s) du site officiel du domaine, ou null si Gemini n'en trouve pas. */
  site: string | null;
  model: string;
  costCents: number;
}

export interface OfficialSiteProvider {
  /** `signal` : délai global de la recherche d'image ; levé, l'appel est abandonné. */
  findOfficialSite(query: OfficialSiteQuery, signal?: AbortSignal): Promise<OfficialSiteResult>;
}
