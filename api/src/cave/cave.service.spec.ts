import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { compileApogeeRules } from '../apogee/apogee';
import { CaveRow } from './cave-filter';
import { CaveService } from './cave.service';

const tempier19: CaveRow = {
  id: 'w19', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019,
  color: 'ROUGE', formatCl: 75, referencePhotoId: 'ref19', quantity: 2,
};
const raw = (vintage: number | null) => ({
  producteur: { value: 'Domaine Tempier', confidence: 0.9 }, cuvee: { value: 'La Tourtine', confidence: 0.9 },
  appellation: { value: 'Bandol', confidence: 0.9 }, millesime: { value: vintage, confidence: vintage ? 0.9 : 0 },
  couleur: { value: 'rouge', confidence: 0.9 }, format_cl: { value: 75, confidence: 0.9 }, degre: { value: null, confidence: 0 },
  pays_region: { value: null, confidence: 0 }, nb_cols_carton: { value: null, confidence: 0 }, confiance_globale: 0.9,
});

function service(photo: any, rows: any[] = [tempier19], rules = compileApogeeRules({ guardOverrides: [], vintageQualities: [] })) {
  const prisma = {
    $queryRaw: jest.fn(async () => rows),
    photo: { findUnique: jest.fn(async () => photo) },
    movement: { findMany: jest.fn(async () => []) },
    wine: { update: jest.fn(async ({ where }: any) => (rows.some((r) => r.id === where.id) ? {} : Promise.reject(new Prisma.PrismaClientKnownRequestError('absent', { code: 'P2025', clientVersion: 'test' })))) },
  };
  return new CaveService(prisma as any, { load: async () => rules } as any);
}

describe('CaveService.exitCandidates', () => {
  it('répond 404 pour une photo inconnue', async () => {
    await expect(service(null).exitCandidates('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('dit que l’analyse est en cours tant que la photo n’est pas lue', async () => {
    expect(await service({ status: 'PROCESSING' }).exitCandidates('p')).toEqual({ status: 'PROCESSING' });
  });

  it('transmet l’échec de l’analyse', async () => {
    expect(await service({ status: 'FAILED', errorMessage: 'saturé' }).exitCandidates('p')).toEqual({ status: 'FAILED', errorMessage: 'saturé' });
  });

  it('classe les vins en stock et renvoie ce que le modèle a lu', async () => {
    const r = await service({ status: 'DONE', purpose: 'EXIT', rawExtraction: raw(2019) }).exitCandidates('p');
    expect(r).toMatchObject({ status: 'DONE', outcome: 'UNIQUE', read: { producer: 'Domaine Tempier', vintage: 2019 } });
    expect((r as any).candidates[0].wine.id).toBe('w19');
    expect((r as any).candidates[0].referencePhotoId).toBe('ref19');
  });

  it('fonctionne aussi sur une photo d’entrée réutilisée par la déduplication', async () => {
    const r = await service({ status: 'DONE', purpose: 'ENTRY', rawExtraction: raw(2019) }).exitCandidates('p');
    expect((r as any).outcome).toBe('UNIQUE');
  });

  it('traite une extraction illisible comme un échec, jamais comme un vin', async () => {
    expect(await service({ status: 'DONE', rawExtraction: { n: 'importe quoi' } }).exitCandidates('p')).toEqual({
      status: 'FAILED',
      errorMessage: 'Lecture de l’étiquette inexploitable',
    });
  });
});

describe('CaveService.detail', () => {
  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, []).detail('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('renvoie le vin avec son stock et ses derniers mouvements', async () => {
    const r = await service(null).detail('w19');
    expect(r.wine).toMatchObject(tempier19);
    expect(r.movements).toEqual([]);
  });
});

const cdp = {
  id: 'w16', producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016,
  color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
  appellationId: 'a-cdp', region: 'Rhône', referenceGuardMin: 8, referenceGuardMax: 20, apogeeMin: null, apogeeMax: null, apogeeSource: null,
};

describe('CaveService — apogée', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(new Date('2026-06-01')));
  afterAll(() => jest.useRealTimers());

  it('calcule l’apogée de chaque vin de la liste', async () => {
    const [item] = await service(null, [cdp]).list({});
    expect(item.apogee).toEqual({ min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' });
  });

  it('n’expose pas les champs internes du calcul', async () => {
    const [item] = await service(null, [cdp]).list({});
    expect(item).not.toHaveProperty('referenceGuardMin');
    expect(item).not.toHaveProperty('apogeeSource');
    expect(item).not.toHaveProperty('region');
  });

  it('applique immédiatement une règle modifiée (aucun cache entre deux requêtes)', async () => {
    const loads = [
      compileApogeeRules({ guardOverrides: [], vintageQualities: [] }),
      compileApogeeRules({ guardOverrides: [], vintageQualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] }),
    ];
    const prisma = { $queryRaw: jest.fn(async () => [cdp]), movement: { findMany: jest.fn(async () => []) } };
    const s = new CaveService(prisma as any, { load: async () => loads.shift()! } as any);
    expect((await s.detail('w16')).wine.apogee).toMatchObject({ min: 2024, max: 2036 });
    expect((await s.detail('w16')).wine.apogee).toMatchObject({ min: 2026, max: 2040, confidence: 'MOYENNE' });
  });

  it('montre la correction manuelle, même pour un vin non millésimé', async () => {
    const nv = { ...cdp, vintage: null, apogeeMin: 2027, apogeeMax: 2029, apogeeSource: 'MANUEL' };
    expect((await service(null, [nv]).detail('w16')).wine.apogee).toMatchObject({ min: 2027, max: 2029, confidence: 'SAISIE' });
  });

  it('enregistre une correction manuelle', async () => {
    const s = service(null, [cdp]);
    await s.setManualApogee('w16', { min: 2030, max: 2035 });
    expect((s as any).prisma.wine.update).toHaveBeenCalledWith({ where: { id: 'w16' }, data: { apogeeMin: 2030, apogeeMax: 2035, apogeeSource: 'MANUEL' } });
  });

  it('retire la correction manuelle', async () => {
    const s = service(null, [cdp]);
    await s.clearManualApogee('w16');
    expect((s as any).prisma.wine.update).toHaveBeenCalledWith({ where: { id: 'w16' }, data: { apogeeMin: null, apogeeMax: null, apogeeSource: null } });
  });

  it('répond 404 pour un vin inconnu', async () => {
    await expect(service(null, [cdp]).setManualApogee('nope', { min: 2030, max: 2035 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
