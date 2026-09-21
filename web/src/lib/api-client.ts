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
  return (await res.json()) as T;
}

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
}

export const getMe = () => apiFetch<Me>('/auth/me');
export const localLogin = (email: string, password: string) =>
  apiFetch<Me>('/auth/local-login', { method: 'POST', body: JSON.stringify({ email, password }) });
export const logout = () => apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });

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

export function uploadPhoto(file: File | Blob) {
  const form = new FormData();
  form.append('file', file, 'photo.jpg');
  return apiFetch<{ id: string; status: string; duplicate: boolean }>('/photos', { method: 'POST', body: form });
}
export const getPhoto = (id: string) => apiFetch<PhotoDto>(`/photos/${id}`);
export const createMovement = (input: CreateMovementInput) =>
  apiFetch<MovementResult>('/movements', { method: 'POST', body: JSON.stringify(input) });

export const getPendingReviewPhotos = () => apiFetch<PhotoDto[]>('/photos/pending-review');
export type BulkResult = Array<{ ok: true; idempotencyKey: string; result: MovementResult } | { ok: false; idempotencyKey: string; error: string }>;
export const createMovementsBulk = (items: CreateMovementInput[]) =>
  apiFetch<BulkResult>('/movements/bulk', { method: 'POST', body: JSON.stringify(items) });
