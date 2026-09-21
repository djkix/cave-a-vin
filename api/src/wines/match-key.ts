import { WineColor } from '@prisma/client';
import { normalizeLabel } from '../appellations/appellations.service';

export interface WineDraft {
  producer: string;
  cuvee?: string | null;
  appellationRaw: string;
  vintage?: number | null;
  color: WineColor;
  formatCl: number;
}

const STOP_WORDS = new Set(['domaine', 'chateau', 'cuvee', 'maison', 'clos']);

export function normalizeName(s: string | null | undefined): string {
  return normalizeLabel(s ?? '')
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(' ');
}

export function computeMatchKey(d: WineDraft): string {
  return [
    normalizeName(d.producer),
    normalizeName(d.cuvee),
    normalizeLabel(d.appellationRaw),
    d.vintage ?? 'NV',
    d.color,
    d.formatCl,
  ].join('|');
}
