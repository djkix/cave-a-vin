export const PAIRING_PROVIDER = 'PAIRING_PROVIDER';

export interface PairingWine {
  producer: string;
  cuvee: string | null;
  appellation: string;
  region: string | null;
  color: string;
  vintage: number | null;
}

/** Plats d'un vin du lot ; `index` : sa position dans le tableau envoyé (à partir de 0). */
export interface PairingBatchItem {
  index: number;
  dishes: string[];
}

/**
 * Un appel pour tout le lot. `items` ne contient que les vins dont la réponse
 * est valide : un vin absent est à redemander. `costCents` : coût de l'appel
 * entier, à répartir sur les vins du lot.
 */
export interface PairingBatchResult {
  items: PairingBatchItem[];
  model: string;
  costCents: number;
}

export interface PairingProvider {
  suggestPairingsBatch(wines: PairingWine[]): Promise<PairingBatchResult>;
}
