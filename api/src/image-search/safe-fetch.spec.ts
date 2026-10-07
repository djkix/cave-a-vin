import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { isBlockedAddress, LookupFn, nodeTransport, RawResponse, safeFetch, SafeFetchError, Transport } from './safe-fetch';

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

function response(status: number, body: Buffer | string = '', headers: Record<string, string> = {}): RawResponse {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    status,
    headers,
    body: (async function* () {
      if (buf.length) yield buf;
    })(),
    close: jest.fn(),
  };
}

describe('isBlockedAddress', () => {
  it.each([
    '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.10', '127.0.0.1', '127.8.8.8',
    '169.254.169.254', '0.0.0.0', '0.1.2.3', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1',
    // 6to4 vers une IPv4 interdite, Teredo, NAT64 local, discard, documentation.
    '2002:7f00:1::', '2002:a00:1::1', '2002:c0a8:101::', '2001::1', '2001:0:4136:e378::1', '64:ff9b:1::a00:1',
    '100::1', '2001:db8::1', '2001:db8:ffff::1',
    // Réseaux de documentation (TEST-NET-1, 2, 3) et relais 6to4 anycast.
    '192.0.2.1', '192.0.2.255', '198.51.100.7', '203.0.113.200', '192.88.99.1', '::ffff:203.0.113.5',
  ])('refuse %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '2002:808:808::1', '2001:4860::8888', '2001:1::1', '192.0.3.1', '198.51.101.1', '203.0.114.1', '192.88.100.1'])(
    'accepte %s', (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );

  it('refuse une adresse illisible', () => expect(isBlockedAddress('pas-une-ip')).toBe(true));
});

describe('safeFetch', () => {
  it('télécharge une adresse publique et rend le contenu, son type et l’adresse finale', async () => {
    const transport: Transport = jest.fn(async () => response(200, 'bonjour', { 'content-type': 'text/html; charset=utf-8' }));
    const r = await safeFetch('https://exemple.fr/page', { maxBytes: 100, lookup: publicLookup, transport });
    expect(r.buffer.toString()).toBe('bonjour');
    expect(r.contentType).toBe('text/html; charset=utf-8');
    expect(r.finalUrl).toBe('https://exemple.fr/page');
    // La connexion part vers l'adresse vérifiée, pas vers une seconde résolution.
    expect((transport as jest.Mock).mock.calls[0][1]).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it.each(['ftp://exemple.fr/a', 'file:///etc/passwd', 'data:text/plain,abc', 'javascript:alert(1)', 'gopher://x/'])(
    'refuse le schéma de %s sans résoudre ni télécharger', async (url) => {
      const lookup = jest.fn(publicLookup);
      const transport = jest.fn();
      await expect(safeFetch(url, { maxBytes: 100, lookup, transport })).rejects.toBeInstanceOf(SafeFetchError);
      expect(lookup).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('refuse une adresse avec identifiants', async () => {
    const transport = jest.fn();
    await expect(safeFetch('https://a:b@exemple.fr/', { maxBytes: 100, lookup: publicLookup, transport })).rejects.toBeInstanceOf(SafeFetchError);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([['10.0.0.5'], ['127.0.0.1'], ['169.254.169.254'], ['192.168.0.1'], ['::1'], ['fe80::1']])(
    'refuse un nom qui se résout en adresse privée (%s)', async (address) => {
      const transport = jest.fn();
      const lookup: LookupFn = async () => [{ address, family: address.includes(':') ? 6 : 4 }];
      await expect(safeFetch('https://interne.exemple/', { maxBytes: 100, lookup, transport })).rejects.toThrow(/adresse interdite/);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('refuse si une seule des adresses résolues est privée', async () => {
    const transport = jest.fn();
    const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await expect(safeFetch('https://mixte.exemple/', { maxBytes: 100, lookup, transport })).rejects.toBeInstanceOf(SafeFetchError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuse une adresse IP littérale privée', async () => {
    const transport = jest.fn();
    const lookup = jest.fn(async (host: string) => [{ address: host, family: 4 }]);
    await expect(safeFetch('http://127.0.0.1:6379/', { maxBytes: 100, lookup, transport })).rejects.toBeInstanceOf(SafeFetchError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('suit une redirection en revérifiant la destination', async () => {
    const transport = jest.fn(async (url: URL) =>
      url.pathname === '/a' ? response(302, '', { location: '/b' }) : response(200, 'ok', { 'content-type': 'image/jpeg' }));
    const r = await safeFetch('https://exemple.fr/a', { maxBytes: 100, lookup: publicLookup, transport });
    expect(r.finalUrl).toBe('https://exemple.fr/b');
    expect(r.buffer.toString()).toBe('ok');
  });

  it('refuse une redirection vers une adresse privée', async () => {
    const lookup: LookupFn = async (host) => [{ address: host === 'piege.exemple' ? '169.254.169.254' : '93.184.216.34', family: 4 }];
    const transport = jest.fn(async () => response(301, '', { location: 'http://piege.exemple/latest/meta-data' }));
    await expect(safeFetch('https://exemple.fr/', { maxBytes: 100, lookup, transport })).rejects.toThrow(/adresse interdite/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuse une redirection vers un autre schéma', async () => {
    const transport = jest.fn(async () => response(302, '', { location: 'file:///etc/passwd' }));
    await expect(safeFetch('https://exemple.fr/', { maxBytes: 100, lookup: publicLookup, transport })).rejects.toBeInstanceOf(SafeFetchError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('s’arrête après 3 redirections', async () => {
    let n = 0;
    const transport = jest.fn(async () => response(302, '', { location: `/r${++n}` }));
    await expect(safeFetch('https://exemple.fr/', { maxBytes: 100, lookup: publicLookup, transport })).rejects.toThrow(/redirections/);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('refuse une réponse en erreur', async () => {
    const transport = jest.fn(async () => response(404, 'non'));
    await expect(safeFetch('https://exemple.fr/', { maxBytes: 100, lookup: publicLookup, transport })).rejects.toThrow(/404/);
  });

  it('refuse une réponse annoncée trop grande sans la lire', async () => {
    const res = response(200, 'x', { 'content-length': '5000' });
    const transport = jest.fn(async () => res);
    await expect(safeFetch('https://exemple.fr/', { maxBytes: 100, lookup: publicLookup, transport })).rejects.toThrow(/trop volumineu/);
    expect(res.close).toHaveBeenCalled();
  });

  it('coupe une réponse qui dépasse la taille maximale en cours de lecture', async () => {
    const res: RawResponse = {
      status: 200,
      headers: {},
      body: (async function* () {
        for (let i = 0; i < 10; i++) yield Buffer.alloc(40, 1);
      })(),
      close: jest.fn(),
    };
    await expect(safeFetch('https://exemple.fr/', { maxBytes: 100, lookup: publicLookup, transport: async () => res })).rejects.toThrow(/trop volumineu/);
    expect(res.close).toHaveBeenCalled();
  });

  it('peut tronquer au lieu de refuser (page HTML : l’en-tête suffit)', async () => {
    const transport = jest.fn(async () => response(200, Buffer.alloc(500, 65), { 'content-type': 'text/html' }));
    const r = await safeFetch('https://exemple.fr/', { maxBytes: 100, overflow: 'truncate', lookup: publicLookup, transport });
    expect(r.buffer.length).toBe(100);
  });

  it('abandonne au-delà du délai', async () => {
    const transport: Transport = (_url, _pinned, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(safeFetch('https://lent.exemple/', { maxBytes: 100, timeoutMs: 30, lookup: publicLookup, transport })).rejects.toThrow(/délai/);
  });

  it('abandonne aussi un corps qui n’arrive pas dans le délai', async () => {
    const res: RawResponse = {
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from('a');
        await new Promise((r) => setTimeout(r, 200));
        yield Buffer.from('b');
      })(),
      close: jest.fn(),
    };
    await expect(safeFetch('https://lent.exemple/', { maxBytes: 100, timeoutMs: 30, lookup: publicLookup, transport: async () => res })).rejects.toThrow(/délai/);
  });

  it('abandonne dès que le signal de la recherche est levé, avant le délai propre', async () => {
    const controller = new AbortController();
    const transport: Transport = (_url, _pinned, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = safeFetch('https://lent.exemple/', { maxBytes: 100, timeoutMs: 60_000, signal: controller.signal, lookup: publicLookup, transport });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await expect(pending).rejects.toThrow(/délai/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('ne télécharge rien si le signal est déjà levé', async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = jest.fn(publicLookup);
    const transport = jest.fn();
    await expect(safeFetch('https://exemple.fr/', { maxBytes: 100, signal: controller.signal, lookup, transport })).rejects.toBeInstanceOf(SafeFetchError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuse un nom introuvable', async () => {
    const lookup: LookupFn = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    await expect(safeFetch('https://inconnu.exemple/', { maxBytes: 100, lookup, transport: jest.fn() })).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('transmet les en-têtes demandés', async () => {
    const transport = jest.fn(async () => response(200, '{}'));
    await safeFetch('https://exemple.fr/', { maxBytes: 100, headers: { 'User-Agent': 'Test/1' }, lookup: publicLookup, transport });
    expect((transport as jest.Mock).mock.calls[0][2].headers).toMatchObject({ 'User-Agent': 'Test/1' });
  });
});

describe('nodeTransport', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`hôte demandé : ${req.headers.host}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('se connecte à l’adresse vérifiée, quel que soit ce que le nom résoudrait ensuite', async () => {
    // « nom.invalid » ne se résout pas : la réponse prouve que la connexion part
    // vers l'adresse épinglée, et que l'en-tête Host garde le nom demandé.
    const controller = new AbortController();
    const res = await nodeTransport(new URL(`http://nom.invalid:${port}/x`), { address: '127.0.0.1', family: 4 }, { headers: {}, signal: controller.signal });
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(c);
    expect(res.status).toBe(200);
    expect(Buffer.concat(chunks).toString()).toBe(`hôte demandé : nom.invalid:${port}`);
  });
});
