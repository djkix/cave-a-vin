export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  return JSON.parse(text) as T;
}

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  status: 'ACTIVE' | 'BLOCKED';
}

export const getMe = () => apiFetch<Me>('/auth/me');
export const localLogin = (email: string, password: string) =>
  apiFetch<Me>('/auth/local-login', { method: 'POST', body: JSON.stringify({ email, password }) });
export const logout = () => apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  status: 'ACTIVE' | 'BLOCKED';
  isAdmin: boolean;
  isBreakGlass: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}
export const getAdminUsers = () => apiFetch<AdminUser[]>('/admin/users');
export const updateAdminUser = (id: string, patch: { status?: AdminUser['status']; isAdmin?: boolean }) =>
  apiFetch<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export type WineColor = 'ROUGE' | 'BLANC' | 'ROSE' | 'PETILLANT';
export interface ExtractedField<T> { value: T | null; confidence: number }
export interface WineExtraction {
  producer: ExtractedField<string>; cuvee: ExtractedField<string>; appellation: ExtractedField<string>;
  vintage: ExtractedField<number>; color: ExtractedField<WineColor>; formatCl: ExtractedField<number>;
  bottlesPerCase: ExtractedField<number>; globalConfidence: number;
}
export interface PhotoDto { id: string; status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED'; rawExtraction?: unknown; extraction?: WineExtraction | null; errorMessage?: string | null; createdAt: string }
export interface WineDraft { producer: string; cuvee?: string | null; appellationRaw: string; vintage?: number | null; color: WineColor; formatCl: number }
export interface CreateMovementInput { idempotencyKey: string; photoId?: string | null; wine: WineDraft; quantity: number; priceUnitCents?: number | null; note?: string | null }
export interface MovementResult { movement: { id: string; delta: number; type: string; occurredAt: string }; wine: WineDraft & { id: string }; stock: number; created: boolean }
export interface PhotoEvent { status: PhotoDto['status']; extraction?: WineExtraction; errorMessage?: string | null }

export function uploadPhoto(file: File | Blob, purpose: 'ENTRY' | 'EXIT' = 'ENTRY') {
  const form = new FormData();
  form.append('file', file, 'photo.jpg');
  form.append('purpose', purpose);
  return apiFetch<{ id: string; status: string; duplicate: boolean }>('/photos', { method: 'POST', body: form });
}
export const getPhoto = (id: string) => apiFetch<PhotoDto>(`/photos/${id}`);

/** Photos stockées qui attendent encore leur analyse, avec le motif du dernier report. */
export interface PhotoQueueStatus { waiting: number; oldestWaitingAt: string | null; lastReason: string | null }
export const getPhotoQueueStatus = () => apiFetch<PhotoQueueStatus>('/photos/queue-status');
export const createMovement = (input: CreateMovementInput) =>
  apiFetch<MovementResult>('/movements', { method: 'POST', body: JSON.stringify(input) });

/**
 * Écran « À confirmer » : photos d'entrée sans mouvement et non écartées, par état.
 * `toConfirm` porte déjà l'extraction lue (`null` si illisible).
 */
export interface EntryInbox { toConfirm: PhotoDto[]; inProgress: PhotoDto[]; failed: PhotoDto[] }
export const getEntryInbox = () => apiFetch<EntryInbox>('/photos/entry-inbox');
/** Écarte une photo d'entrée restée sans mouvement (409 si elle a déjà servi). */
export const dismissPhoto = (id: string) => apiFetch<{ ok: true }>(`/photos/${id}/dismiss`, { method: 'POST' });
export type BulkResult = Array<{ ok: true; idempotencyKey: string; result: MovementResult } | { ok: false; idempotencyKey: string; error: string }>;
export const createMovementsBulk = (items: CreateMovementInput[]) =>
  apiFetch<BulkResult>('/movements/bulk', { method: 'POST', body: JSON.stringify(items) });

export interface MovementWithWine {
  id: string; delta: number; type: 'IN' | 'OUT' | 'ADJUST'; occurredAt: string; note: string | null; reversesId: string | null;
  wine: { id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null };
}
export const getRecentMovements = (limit = 20) => apiFetch<MovementWithWine[]>(`/movements/recent?limit=${limit}`);
export const cancelMovement = (id: string, idempotencyKey: string) =>
  apiFetch<MovementResult>(`/movements/${id}/cancel`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) });
export function exportUrl(filter: { color?: WineColor; region?: string; drinkSoon?: boolean } = {}) {
  const q = new URLSearchParams();
  if (filter.color) q.set('color', filter.color);
  if (filter.region) q.set('region', filter.region);
  if (filter.drinkSoon) q.set('drinkSoon', 'true');
  const s = q.toString();
  return `/api/export.xlsx${s ? `?${s}` : ''}`;
}

export type ApogeeConfidence = 'SAISIE' | 'MOYENNE' | 'FAIBLE';
export type ApogeeStatus = 'TROP_JEUNE' | 'A_BOIRE' | 'A_BOIRE_VITE' | 'PASSEE';
export type ApogeeReason = 'NON_MILLESIME' | 'APPELLATION_INCONNUE' | 'GARDE_INCONNUE';
export interface Apogee {
  min: number | null; max: number | null; confidence: ApogeeConfidence | null;
  status: ApogeeStatus | null; reason: ApogeeReason | null; source: 'MANUEL' | 'REGLE' | null;
}

export interface Rating { value: number; ratedAt: string; ratedBy: string | null }
export interface Pairing { status: 'PENDING' | 'DONE' | 'FAILED'; dishes: string[]; errorMessage: string | null; generatedAt: string | null }

export type ProducerProfileStatus = 'PENDING' | 'DONE' | 'UNKNOWN' | 'FAILED';
export type ProducerProfileSource = 'GEMINI' | 'MANUEL';
export interface ProducerProfile {
  key: string; displayName: string; status: ProducerProfileStatus; description: string | null;
  source: ProducerProfileSource; errorMessage: string | null; generatedAt: string | null; updatedBy: string | null;
}

export interface CaveRow {
  id: string; producer: string; cuvee: string | null; appellationRaw: string; vintage: number | null;
  color: WineColor; formatCl: number; referencePhotoId: string | null; quantity: number;
  /** Toujours fourni par la liste et la fiche ; absent des candidats de sortie. */
  apogee?: Apogee;
  rating?: Rating | null;
  /** Plat demandé en filtre, uniquement présent quand `GET /cave?dish=` l'a retenu. */
  matchedDish?: string;
}
export interface CaveFilter { q?: string; color?: WineColor; includeEmpty?: boolean; drinkSoon?: boolean; noApogee?: boolean; dish?: string }
export function getCave(filter: CaveFilter) {
  const q = new URLSearchParams();
  if (filter.q) q.set('q', filter.q);
  if (filter.color) q.set('color', filter.color);
  if (filter.includeEmpty) q.set('includeEmpty', 'true');
  if (filter.drinkSoon) q.set('drinkSoon', 'true');
  if (filter.noApogee) q.set('noApogee', 'true');
  if (filter.dish) q.set('dish', filter.dish);
  const s = q.toString();
  return apiFetch<CaveRow[]>(`/cave${s ? `?${s}` : ''}`);
}

export interface WineDetail {
  wine: CaveRow & {
    pairing?: Pairing | null; producerKey: string | null; producerProfile?: ProducerProfile | null;
    /** Non nuls ⇔ la vignette vient d'une recherche web (afficher la source et « Revenir à ma photo »). */
    referencePhotoSource: string | null; referencePhotoSourceUrl: string | null;
  };
  movements: Array<{ id: string; delta: number; type: 'IN' | 'OUT' | 'ADJUST'; occurredAt: string; note: string | null; reversesId: string | null }>;
}
export const getWine = (id: string) => apiFetch<WineDetail>(`/wines/${id}`);

/** Candidate trouvée par la recherche d'image : `imageUrl` sert toujours la miniature via l'api (jamais une adresse tierce directement). */
export interface ImageCandidate { id: string; source: string; sourceUrl: string; imageUrl: string }
export const searchWineImages = (wineId: string) =>
  apiFetch<{ candidates: ImageCandidate[] }>(`/wines/${wineId}/image-search`, { method: 'POST' });

export interface ReferenceImageResult { referencePhotoId: string; referencePhotoSource: string; referencePhotoSourceUrl: string }
export const chooseReferenceImage = (wineId: string, candidateId: string) =>
  apiFetch<ReferenceImageResult>(`/wines/${wineId}/reference-image`, { method: 'POST', body: JSON.stringify({ candidateId }) });

export interface RevertReferenceImageResult { referencePhotoId: string | null; referencePhotoSource: null; referencePhotoSourceUrl: null }
export const revertReferenceImage = (wineId: string) =>
  apiFetch<RevertReferenceImageResult>(`/wines/${wineId}/reference-image`, { method: 'DELETE' });

export const setRating = (wineId: string, rating: number) =>
  apiFetch<Rating>(`/wines/${wineId}/rating`, { method: 'PUT', body: JSON.stringify({ rating }) });
export const clearRating = (wineId: string) => apiFetch<null>(`/wines/${wineId}/rating`, { method: 'DELETE' });
export const regeneratePairing = (wineId: string) => apiFetch<void>(`/wines/${wineId}/pairing/regenerate`, { method: 'POST' });

export const setProducerDescription = (producerKey: string, description: string) =>
  apiFetch<ProducerProfile>(`/producers/${encodeURIComponent(producerKey)}/description`, { method: 'PUT', body: JSON.stringify({ description }) });
export const regenerateProducer = (producerKey: string) =>
  apiFetch<void>(`/producers/${encodeURIComponent(producerKey)}/regenerate`, { method: 'POST' });

export const createOut = (input: { idempotencyKey: string; wineId: string; quantity: number; photoId?: string | null }) =>
  apiFetch<MovementResult>('/movements/out', { method: 'POST', body: JSON.stringify(input) });

export interface InventoryResult { movement: { id: string } | null; stock: number; delta: number; created: boolean }
export const postInventory = (wineId: string, input: { idempotencyKey: string; counted: number }) =>
  apiFetch<InventoryResult>(`/wines/${wineId}/inventory`, { method: 'POST', body: JSON.stringify(input) });

export interface ExitRead { producer: string | null; cuvee: string | null; appellation: string | null; vintage: number | null }
export interface ExitCandidate { wine: Omit<CaveRow, 'quantity' | 'referencePhotoId'>; quantity: number; referencePhotoId: string | null; score: number }
export type ExitCandidatesResponse =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'FAILED'; errorMessage: string | null }
  | { status: 'DONE'; outcome: 'UNIQUE' | 'SEVERAL' | 'NONE'; read: ExitRead; candidates: ExitCandidate[] };
export const getExitCandidates = (photoId: string) => apiFetch<ExitCandidatesResponse>(`/photos/${photoId}/exit-candidates`);

export const setApogee = (wineId: string, input: { min: number; max: number }) =>
  apiFetch<Apogee>(`/wines/${wineId}/apogee`, { method: 'PUT', body: JSON.stringify(input) });
export const clearApogee = (wineId: string) => apiFetch<Apogee>(`/wines/${wineId}/apogee`, { method: 'DELETE' });

export type VintageQualityLevel = 'GRAND' | 'MOYEN' | 'FAIBLE';
export interface VintageQualityRow { region: string; year: number; quality: VintageQualityLevel }
export const getVintages = () => apiFetch<{ regions: string[]; qualities: VintageQualityRow[] }>('/admin/vintages');
export const putVintage = (row: VintageQualityRow) =>
  apiFetch<VintageQualityRow>('/admin/vintages', { method: 'PUT', body: JSON.stringify(row) });
/** La région peut porter un accent ou un tiret (« Rhône », « Languedoc-Roussillon ») : elle est encodée dans l'adresse. */
export const deleteVintage = (region: string, year: number) =>
  apiFetch<void>(`/admin/vintages/${encodeURIComponent(region)}/${year}`, { method: 'DELETE' });

export interface GuardAppellation {
  id: string; canonicalName: string; region: string | null; guardMinYears: number | null; guardMaxYears: number | null;
  overrides: Array<{ id: string; color: WineColor | null; min: number; max: number }>;
}
export const searchGuards = (q: string) => apiFetch<GuardAppellation[]>(`/admin/guards?q=${encodeURIComponent(q)}`);
export const putGuard = (input: { appellationId: string; color: WineColor | null; min: number; max: number }) =>
  apiFetch<{ id: string; color: WineColor | null; min: number; max: number }>('/admin/guards', { method: 'PUT', body: JSON.stringify(input) });
export const deleteGuard = (id: string) => apiFetch<void>(`/admin/guards/${id}`, { method: 'DELETE' });

export type ReadField = 'producer' | 'cuvee' | 'appellationRaw' | 'vintage' | 'color' | 'formatCl';
export interface ReadingQuality {
  days: number; entries: number; rate: number | null;
  fields: Array<{ field: ReadField; corrected: number; rate: number | null }>;
}
export const getReadingQuality = () => apiFetch<ReadingQuality>('/admin/reading-quality');

export interface StatsShare { key: string; bottles: number; share: number }
export interface StatsRankedWine { id: string; producer: string; cuvee: string | null; vintage: number | null; value: number }
export interface Stats {
  bottles: number; references: number; pricedReferences: number; purchaseValueCents: number | null;
  byColor: StatsShare[]; byRegion: StatsShare[]; byDecade: StatsShare[]; byApogee: StatsShare[];
  months: Array<{ month: string; in: number; out: number }>;
  drinkRate: number; yearsLeft: number | null;
  mostDrunk: StatsRankedWine[]; topProducers: Array<{ producer: string; bottles: number }>; mostExpensive: StatsRankedWine[];
  bestRated: StatsRankedWine[];
}
export const getStats = () => apiFetch<Stats>('/stats');
