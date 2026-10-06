/** Ce que la fiche vin montre du domaine (GET /api/wines/:id → `wine.producerProfile`). */
export interface ProducerProfileView {
  key: string;
  displayName: string;
  status: string;
  description: string | null;
  source: string;
  errorMessage: string | null;
  generatedAt: Date | null;
  /** Auteur d'un texte saisi : nom affiché, à défaut e-mail ; null sinon. */
  updatedBy: string | null;
}

export interface ProducerProfileRow {
  producerKey: string;
  displayName: string;
  status: string;
  description: string | null;
  source: string;
  errorMessage: string | null;
  generatedAt: Date | null;
  updatedBy: { displayName: string | null; email: string } | null;
}

/** À passer en `include` pour lire l'auteur avec le descriptif. */
export const PRODUCER_PROFILE_INCLUDE = { updatedBy: { select: { displayName: true, email: true } } } as const;

export function producerProfileOf(p: ProducerProfileRow | null): ProducerProfileView | null {
  if (!p) return null;
  return {
    key: p.producerKey,
    displayName: p.displayName,
    status: p.status,
    description: p.description,
    source: p.source,
    errorMessage: p.errorMessage,
    generatedAt: p.generatedAt,
    updatedBy: p.updatedBy ? (p.updatedBy.displayName ?? p.updatedBy.email) : null,
  };
}
