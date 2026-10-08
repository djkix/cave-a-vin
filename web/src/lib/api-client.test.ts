import * as api from './api-client';
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

  it('conserve les en-têtes personnalisés tout en ajoutant Content-Type JSON', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/x', { method: 'POST', headers: { 'X-Foo': 'bar' }, body: '{}' });
    const init = fetchSpy.mock.calls[0][1];
    expect(init?.headers).toEqual({ 'X-Foo': 'bar', 'Content-Type': 'application/json' });
  });

  it("n'ajoute pas de Content-Type pour un corps FormData", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/upload', { method: 'POST', body: new FormData() });
    const init = fetchSpy.mock.calls[0][1];
    expect(init?.headers).toBeUndefined();
  });

  it('renvoie undefined pour un corps vide, même hors 204 (200 ou 202)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    await expect(apiFetch('/wines/w1/rating', { method: 'DELETE' })).resolves.toBeUndefined();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }));
    await expect(apiFetch('/wines/w1/pairing/regenerate', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('continue de parser le JSON pour un corps non vide hors 204', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ value: 16.5 }), { status: 202 }));
    await expect(apiFetch('/x')).resolves.toEqual({ value: 16.5 });
  });
});

describe('caves, membres et administration', () => {
  afterEach(() => vi.restoreAllMocks());

  async function call(run: () => Promise<unknown>, body = '{}', status = 200) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(status === 204 ? null : body, { status }));
    await run();
    const [url, init] = fetchSpy.mock.calls[0];
    return { url, method: init?.method ?? 'GET', body: init?.body };
  }

  it('change la cave courante', async () => {
    expect(await call(() => api.setCurrentCave('c2'))).toEqual({ url: '/api/auth/current-cave', method: 'PUT', body: '{"caveId":"c2"}' });
  });

  it('liste, invite et retire les membres, renomme la cave', async () => {
    expect(await call(() => api.getMembers(), '[]')).toEqual({ url: '/api/caves/current/members', method: 'GET', body: undefined });
    expect(await call(() => api.inviteMember('a@b.c'))).toEqual({ url: '/api/caves/current/members', method: 'POST', body: '{"email":"a@b.c"}' });
    expect(await call(() => api.removeMember('m1'), '', 204)).toEqual({ url: '/api/caves/current/members/m1', method: 'DELETE', body: undefined });
    expect(await call(() => api.renameCave('Ma cave'))).toEqual({ url: '/api/caves/current', method: 'PATCH', body: '{"name":"Ma cave"}' });
  });

  it('zones de la cave : liste, création, modification, ordre, suppression, photo', async () => {
    expect(await call(() => api.getZones(), '[]')).toEqual({ url: '/api/caves/current/zones', method: 'GET', body: undefined });
    expect(await call(() => api.createZone({ name: 'Garage', indication: 'Au fond' }))).toEqual({ url: '/api/caves/current/zones', method: 'POST', body: '{"name":"Garage","indication":"Au fond"}' });
    expect(await call(() => api.updateZone('z1', { name: 'Cellier' }))).toEqual({ url: '/api/caves/current/zones/z1', method: 'PATCH', body: '{"name":"Cellier"}' });
    expect(await call(() => api.reorderZones(['z2', 'z1']), '[]')).toEqual({ url: '/api/caves/current/zones/order', method: 'POST', body: '{"ids":["z2","z1"]}' });
    expect(await call(() => api.deleteZone('z1'), '{"archived":true}')).toEqual({ url: '/api/caves/current/zones/z1', method: 'DELETE', body: undefined });
    const upload = await call(() => api.uploadZonePhoto('z1', new Blob(['x'], { type: 'image/jpeg' })));
    expect({ url: upload.url, method: upload.method }).toEqual({ url: '/api/caves/current/zones/z1/photo', method: 'PUT' });
    expect((upload.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(await call(() => api.removeZonePhoto('z1'))).toEqual({ url: '/api/caves/current/zones/z1/photo', method: 'DELETE', body: undefined });
    expect(api.zonePhotoUrl('z1')).toBe('/api/caves/zones/z1/photo');
    expect(api.zonePhotoUrl('z1', 3)).toBe('/api/caves/zones/z1/photo?v=3');
  });

  it('gère les inscriptions, la cave d’un compte et le budget', async () => {
    expect(await call(() => api.getRegistrations(), '[]')).toEqual({ url: '/api/admin/registrations', method: 'GET', body: undefined });
    expect(await call(() => api.validateRegistration('u1'))).toEqual({ url: '/api/admin/registrations/u1/validate', method: 'POST', body: undefined });
    expect(await call(() => api.refuseRegistration('u1'))).toEqual({ url: '/api/admin/registrations/u1/refuse', method: 'POST', body: undefined });
    expect(await call(() => api.createUserCave('u1'))).toEqual({ url: '/api/admin/users/u1/cave', method: 'POST', body: undefined });
    expect(await call(() => api.getAdminBudget())).toEqual({ url: '/api/admin/budget', method: 'GET', body: undefined });
    expect(await call(() => api.putAdminBudget({ caveShare: 0.35, invitedShare: 0.6 }))).toEqual({ url: '/api/admin/budget', method: 'PUT', body: '{"caveShare":0.35,"invitedShare":0.6}' });
  });
});
