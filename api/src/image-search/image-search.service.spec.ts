import { GoneException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { VisionBudgetExceededError } from '../queue/vision-budget.service';
import { CandidateStore } from './candidates';
import { ImageSearchService } from './image-search.service';
import { OFF_SOURCE } from './open-food-facts';

const WINE = { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Migoua', appellationRaw: 'Bandol', vintage: 2019 };

let jpeg: Buffer;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#802030' } }).jpeg().toBuffer();
});

const OFF_HIT = { products: [{ code: '123', categories_tags: ['en:wines'], image_front_url: 'https://images.openfoodfacts.org/123/front.jpg' }] };
const SITE_HTML = '<html><head><meta property="og:image" content="https://tempier.fr/og.jpg"></head><body></body></html>';

/** Réseau simulé : Open Food Facts, le site officiel et les images. */
function network(off: unknown = { products: [] }) {
  return jest.fn(async (url: string) => {
    if (url.startsWith('https://world.openfoodfacts.org/cgi/search.pl')) {
      return { buffer: Buffer.from(JSON.stringify(off)), contentType: 'application/json', finalUrl: url };
    }
    if (url === 'https://tempier.fr/') return { buffer: Buffer.from(SITE_HTML), contentType: 'text/html', finalUrl: url };
    return { buffer: jpeg, contentType: 'image/jpeg', finalUrl: url };
  });
}

function setup(opts: { off?: unknown; site?: string | null; budgetError?: Error; providerError?: Error; wine?: typeof WINE | null } = {}) {
  const fetcher = network(opts.off);
  const dir = mkdtempSync(join(tmpdir(), 'cave-image-search-'));
  const store = new CandidateStore(dir, fetcher);
  const prisma = {
    wine: { findUnique: jest.fn(async () => (opts.wine === undefined ? WINE : opts.wine)) },
    imageSearchCost: { create: jest.fn(async () => ({})) },
  };
  const budget = { assertUnderShare: jest.fn(async () => { if (opts.budgetError) throw opts.budgetError; }) };
  const provider = {
    findOfficialSite: jest.fn(async () => {
      if (opts.providerError) throw opts.providerError;
      return { site: opts.site === undefined ? 'https://tempier.fr/' : opts.site, model: 'gemini-test', costCents: 1 };
    }),
  };
  const service = new ImageSearchService(prisma as any, store, budget as any, provider, dir, fetcher);
  return { service, prisma, budget, provider, fetcher };
}

describe('ImageSearchService.search', () => {
  it('propose d’abord les images d’Open Food Facts, sans appeler Gemini', async () => {
    const { service, provider, budget } = setup({ off: OFF_HIT });
    const r = await service.search('w1');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      source: OFF_SOURCE,
      sourceUrl: 'https://world.openfoodfacts.org/product/123',
      imageUrl: `/api/image-candidates/${r.candidates[0].id}`,
    });
    expect(provider.findOfficialSite).not.toHaveBeenCalled();
    expect(budget.assertUnderShare).not.toHaveBeenCalled();
  });

  it('sans résultat Open Food Facts, cherche le site officiel sous 80 % du plafond et compte la dépense', async () => {
    const { service, provider, budget, prisma } = setup();
    const r = await service.search('w1');
    expect(budget.assertUnderShare).toHaveBeenCalledWith(0.8);
    expect(provider.findOfficialSite).toHaveBeenCalledWith({ producer: 'Domaine Tempier', cuvee: 'La Migoua', appellation: 'Bandol', vintage: 2019 });
    expect(prisma.imageSearchCost.create).toHaveBeenCalledWith({ data: { wineId: 'w1', model: 'gemini-test', costCents: 1 } });
    expect(r.candidates).toEqual([expect.objectContaining({ source: 'tempier.fr', sourceUrl: 'https://tempier.fr/' })]);
  });

  it('passe aussi au site quand les images d’Open Food Facts sont toutes inaccessibles', async () => {
    const { service, provider, fetcher } = setup({ off: OFF_HIT });
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string) => {
      if (url.includes('images.openfoodfacts.org')) throw new Error('404');
      return base(url);
    });
    const r = await service.search('w1');
    expect(provider.findOfficialSite).toHaveBeenCalled();
    expect(r.candidates.map((c) => c.source)).toEqual(['tempier.fr']);
  });

  it('rend une liste vide quand Gemini ne connaît pas de site', async () => {
    const { service, prisma } = setup({ site: null });
    expect(await service.search('w1')).toEqual({ candidates: [] });
    // L'appel a eu lieu : il est compté même sans résultat.
    expect(prisma.imageSearchCost.create).toHaveBeenCalled();
  });

  it('plafond atteint : 503 « Recherche d’image indisponible pour le moment », sans appeler Gemini', async () => {
    const { service, provider } = setup({ budgetError: new VisionBudgetExceededError() });
    const e = await service.search('w1').catch((x) => x);
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.message).toBe('Recherche d’image indisponible pour le moment');
    expect(provider.findOfficialSite).not.toHaveBeenCalled();
  });

  it('Gemini en panne : 503', async () => {
    const { service, prisma } = setup({ providerError: new Error('500 Internal') });
    const e = await service.search('w1').catch((x) => x);
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.message).toBe('Recherche d’image indisponible pour le moment');
    expect(prisma.imageSearchCost.create).not.toHaveBeenCalled();
  });

  it('vin inconnu : 404 « Vin introuvable »', async () => {
    const { service } = setup({ wine: null });
    const e = await service.search('nope').catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe('Vin introuvable');
  });
});

describe('ImageSearchService.candidateImage', () => {
  it('candidate inconnue ou expirée : 410 « Proposition expirée, relancez la recherche »', async () => {
    const { service } = setup();
    const e = await service.candidateImage('00000000-0000-4000-8000-000000000000').catch((x) => x);
    expect(e).toBeInstanceOf(GoneException);
    expect(e.message).toBe('Proposition expirée, relancez la recherche');
  });

  it('rend le JPEG d’une candidate récente', async () => {
    const { service } = setup({ off: OFF_HIT });
    const { candidates } = await service.search('w1');
    const image = await service.candidateImage(candidates[0].id);
    expect((await sharp(image).metadata()).format).toBe('jpeg');
  });
});
