export const PRODUCER_PROVIDER = 'PRODUCER_PROVIDER';

export interface ProducerQuery {
  /** Nom du domaine tel que vu la première fois. */
  producer: string;
  /** Appellations de ses vins en cave : situent le domaine. */
  appellations: string[];
  region: string | null;
}

/** Descriptif d'un domaine du lot ; `index` : sa position dans le tableau envoyé (à partir de 0). */
export interface ProducerBatchItem {
  index: number;
  /** false : Gemini n'a pas d'information fiable sur ce domaine. */
  known: boolean;
  description: string | null;
}

/**
 * Un appel pour tout le lot. `items` ne contient que les domaines dont la
 * réponse est valide : un domaine absent est à redemander. `costCents` : coût
 * de l'appel entier, à répartir sur les domaines du lot.
 */
export interface ProducerBatchResult {
  items: ProducerBatchItem[];
  model: string;
  costCents: number;
}

export interface ProducerProvider {
  describeProducersBatch(queries: ProducerQuery[]): Promise<ProducerBatchResult>;
}
