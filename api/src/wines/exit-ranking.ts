import { normalizeLabel } from '../appellations/appellations.service';
import { normalizeName } from './match-key';
import { trigramSimilarity } from './trigram';

// Valeurs initiales de la spécification du lot 2a, calées sur les cas de
// exit-ranking.spec.ts. Les modifier, c'est rejouer ces cas d'abord.
export const W_NAME = 0.6;
export const W_APPELLATION = 0.4;
export const VINTAGE_MATCH_BONUS = 0.25;
export const VINTAGE_MISMATCH_FACTOR = 0.3;
export const MIN_CANDIDATE_SCORE = 0.35;
export const UNIQUE_MIN_SCORE = 0.6;
export const UNIQUE_MIN_GAP = 0.15;
export const MAX_CANDIDATES = 4;

export interface ExitRead {
  producer: string | null;
  cuvee: string | null;
  appellation: string | null;
  vintage: number | null;
}

export interface InStockWine {
  wine: { id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null; color: string; formatCl: number };
  quantity: number;
  referencePhotoId: string | null;
}

export type ExitOutcome = 'UNIQUE' | 'SEVERAL' | 'NONE';

export interface ExitCandidate extends InStockWine {
  score: number;
}

function nameOf(producer: string | null, cuvee: string | null): string {
  return `${normalizeName(producer)} ${normalizeName(cuvee)}`.trim();
}

/**
 * Classe les vins en stock face à ce que le modèle a lu sur l'étiquette.
 *
 * Le millésime pèse lourd : c'est le seul discriminant entre deux millésimes du
 * même vin, cas le plus fréquent d'une cave. Égal, il ajoute un bonus ; connu des
 * deux côtés et différent, il écrase le score ; illisible, il est neutre — et
 * c'est alors à l'utilisateur de départager sur les vignettes.
 *
 * Un candidat n'est déclaré UNIQUE que s'il est à la fois sûr et nettement
 * devant : sinon il est montré en vignette, jamais confirmé d'office.
 */
export function rankExitCandidates(read: ExitRead, inStock: InStockWine[]): { outcome: ExitOutcome; candidates: ExitCandidate[] } {
  const readName = nameOf(read.producer, read.cuvee);
  const readAppellation = read.appellation ? normalizeLabel(read.appellation) : '';
  if (!readName && !readAppellation) return { outcome: 'NONE', candidates: [] };

  const scored: ExitCandidate[] = inStock
    .filter((s) => s.quantity > 0)
    .map((s) => {
      const nameScore = trigramSimilarity(readName, nameOf(s.wine.producer, s.wine.cuvee));
      let score = readAppellation
        ? W_NAME * nameScore + W_APPELLATION * trigramSimilarity(readAppellation, normalizeLabel(s.wine.appellationRaw))
        : nameScore;
      if (read.vintage != null && s.wine.vintage != null) {
        score = read.vintage === s.wine.vintage ? score + VINTAGE_MATCH_BONUS : score * VINTAGE_MISMATCH_FACTOR;
      }
      return { ...s, score: Math.round(score * 1000) / 1000 };
    })
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  if (scored.length === 0) return { outcome: 'NONE', candidates: [] };
  const [first, second] = scored;
  const unique = first.score >= UNIQUE_MIN_SCORE && (!second || first.score - second.score >= UNIQUE_MIN_GAP);
  return { outcome: unique ? 'UNIQUE' : 'SEVERAL', candidates: scored };
}
