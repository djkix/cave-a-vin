import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { CANDIDATE_TTL_MS, CandidateExpiredError, CandidateStore } from './candidates';

const remote = { imageUrl: 'https://images.exemple/front.png', source: 'Open Food Facts (CC BY-SA)', sourceUrl: 'https://world.openfoodfacts.org/product/1' };

async function png(width = 2400, height = 1600) {
  return sharp({ create: { width, height, channels: 3, background: '#7a1f2b' } }).png().toBuffer();
}

function fetcherOf(buffer: Buffer, contentType: string | null = 'image/png') {
  return jest.fn(async (url: string) => ({ buffer, contentType, finalUrl: url }));
}

describe('CandidateStore', () => {
  let dir: string;
  let clock: number;
  const store = (fetcher: ReturnType<typeof fetcherOf>) => new CandidateStore(dir, fetcher, () => clock);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cave-candidates-'));
    clock = Date.parse('2026-10-07T10:00:00Z');
  });

  it('télécharge l’image (5 Mo au plus), la réduit à 1200 px en JPEG et la garde sous candidates/', async () => {
    const fetcher = fetcherOf(await png());
    const c = await store(fetcher).add(remote, 'w1');
    expect(c).toMatchObject({ source: remote.source, sourceUrl: remote.sourceUrl, wineId: 'w1' });
    expect(fetcher).toHaveBeenCalledWith(remote.imageUrl, expect.objectContaining({ maxBytes: 5 * 1024 * 1024 }));
    const file = join(dir, 'candidates', `${c!.id}.jpg`);
    expect(existsSync(file)).toBe(true);
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(1200);
    expect((await store(fetcher).read(c!.id)).equals(readFileSync(file))).toBe(true);
  });

  it.each([['image/gif'], ['text/html'], ['image/svg+xml'], [null]])('refuse le type %s', async (type) => {
    expect(await store(fetcherOf(await png(), type)).add(remote, 'w1')).toBeNull();
  });

  it('refuse un contenu qui n’est pas l’image annoncée', async () => {
    expect(await store(fetcherOf(Buffer.from('<svg/>'), 'image/jpeg')).add(remote, 'w1')).toBeNull();
  });

  it('refuse une image de plus de 25 millions de pixels (bombe de décompression)', async () => {
    const huge = await sharp({ create: { width: 5100, height: 5000, channels: 3, background: '#000' } }).png({ compressionLevel: 1 }).toBuffer();
    expect(await store(fetcherOf(huge)).add(remote, 'w1')).toBeNull();
    // Juste sous la limite : acceptée.
    const big = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#000' } }).png({ compressionLevel: 1 }).toBuffer();
    expect(await store(fetcherOf(big)).add(remote, 'w1')).not.toBeNull();
  }, 30_000);

  it('une candidate est liée au vin cherché : pour un autre vin, elle vaut expirée', async () => {
    const s = store(fetcherOf(await png(300, 300)));
    const c = (await s.add(remote, 'w1'))!;
    await expect(s.get(c.id, 'w2')).rejects.toBeInstanceOf(CandidateExpiredError);
    await expect(s.take(c.id, join(dir, 'normalized', 'x.jpg'), 'w2')).rejects.toBeInstanceOf(CandidateExpiredError);
    await expect(s.get(c.id, 'w1')).resolves.toMatchObject({ wineId: 'w1' });
    // L'image elle-même reste lisible (route sans vin).
    await expect(s.read(c.id)).resolves.toBeInstanceOf(Buffer);
  });

  it('rend null si le téléchargement échoue', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('Téléchargement refusé : adresse interdite');
    });
    expect(await new CandidateStore(dir, fetcher, () => clock).add(remote, 'w1')).toBeNull();
  });

  it('une candidate expire au bout d’une heure (410)', async () => {
    const s = store(fetcherOf(await png(300, 300)));
    const c = (await s.add(remote, 'w1'))!;
    clock += CANDIDATE_TTL_MS - 1000;
    await expect(s.get(c.id)).resolves.toMatchObject({ id: c.id });
    clock += 2000;
    await expect(s.get(c.id)).rejects.toBeInstanceOf(CandidateExpiredError);
    await expect(s.read(c.id)).rejects.toBeInstanceOf(CandidateExpiredError);
  });

  it('une candidate inconnue ou un identifiant forgé vaut expirée, sans toucher au disque hors de candidates/', async () => {
    const s = store(fetcherOf(await png(300, 300)));
    await expect(s.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(CandidateExpiredError);
    await expect(s.get('../normalized/x')).rejects.toBeInstanceOf(CandidateExpiredError);
  });

  it('le nettoyage efface les candidates de plus d’une heure et garde les récentes', async () => {
    const s = store(fetcherOf(await png(300, 300)));
    const old = (await s.add(remote, 'w1'))!;
    clock += 30 * 60_000;
    const recent = (await s.add(remote, 'w1'))!;
    clock += 31 * 60_000;
    await s.cleanup();
    const files = readdirSync(join(dir, 'candidates'));
    expect(files.filter((f) => f.startsWith(old.id))).toEqual([]);
    expect(files.filter((f) => f.startsWith(recent.id)).sort()).toEqual([`${recent.id}.jpg`, `${recent.id}.json`]);
  });

  it('take déplace le fichier et oublie la candidate', async () => {
    const s = store(fetcherOf(await png(300, 300)));
    const c = (await s.add(remote, 'w1'))!;
    const dest = join(dir, 'normalized', 'ref.jpg');
    await expect(s.take(c.id, dest, 'w1')).resolves.toMatchObject({ source: remote.source });
    expect(existsSync(dest)).toBe(true);
    await expect(s.get(c.id)).rejects.toBeInstanceOf(CandidateExpiredError);
  });
});
