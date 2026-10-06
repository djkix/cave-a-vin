export const PRODUCER_PROVIDER = 'PRODUCER_PROVIDER';

export interface ProducerQuery {
  /** Nom du domaine tel que vu la première fois. */
  producer: string;
  /** Appellations de ses vins en cave : situent le domaine. */
  appellations: string[];
  region: string | null;
}

export interface ProducerResult {
  /** false : Gemini n'a pas d'information fiable sur ce domaine. */
  known: boolean;
  description: string | null;
  model: string;
  costCents: number;
}

export interface ProducerProvider {
  describeProducer(query: ProducerQuery): Promise<ProducerResult>;
}
