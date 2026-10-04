/**
 * Similarité trigramme, définition de pg_trgm : chaque mot est complété de deux
 * espaces devant et d'un derrière, découpé en trigrammes, et la similarité est
 * le rapport entre trigrammes communs et trigrammes distincts des deux côtés.
 *
 * Calculée en mémoire plutôt qu'en SQL : la sortie compare une lecture à
 * quelques centaines de vins au plus, et une fonction pure se teste sans base.
 * Les entrées doivent déjà être normalisées (minuscules, sans accents).
 */
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(' ')) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / (ta.size + tb.size - common);
}
