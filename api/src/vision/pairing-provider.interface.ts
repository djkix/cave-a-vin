export const PAIRING_PROVIDER = 'PAIRING_PROVIDER';

export interface PairingWine {
  producer: string;
  cuvee: string | null;
  appellation: string;
  region: string | null;
  color: string;
  vintage: number | null;
}

export interface PairingResult {
  dishes: string[];
  model: string;
  costCents: number;
}

export interface PairingProvider {
  suggestPairings(wine: PairingWine): Promise<PairingResult>;
}
