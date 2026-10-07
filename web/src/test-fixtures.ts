import type { CaveSummary, Me } from './lib/api-client';

export const OWNER_CAVE: CaveSummary = { id: 'c1', name: 'Cave de Franck', role: 'OWNER' };
export const VIEWER_CAVE: CaveSummary = { id: 'c2', name: 'Cave de Paul', role: 'VIEWER' };

/** Compte actif, propriétaire d'une seule cave, non administrateur. */
export function meFixture(overrides: Partial<Me> = {}): Me {
  return {
    id: 'u1', email: 'franck@example.com', displayName: 'Franck', isAdmin: false, status: 'ACTIVE',
    caves: [OWNER_CAVE], currentCaveId: OWNER_CAVE.id,
    ...overrides,
  };
}

/** Membre en lecture seule d'une seule cave. */
export const viewerMe = (overrides: Partial<Me> = {}): Me =>
  meFixture({ caves: [VIEWER_CAVE], currentCaveId: VIEWER_CAVE.id, ...overrides });
