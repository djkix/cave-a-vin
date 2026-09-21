import { apiFetch, ApiError } from './api-client';

describe('apiFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns parsed JSON on 2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(apiFetch<{ ok: number }>('/health')).resolves.toEqual({ ok: 1 });
  });

  it('throws ApiError with the server message on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Connexion requise' }), { status: 401 }),
    );
    await expect(apiFetch('/auth/me')).rejects.toMatchObject({ status: 401, message: 'Connexion requise' });
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(ApiError);
  });
});
