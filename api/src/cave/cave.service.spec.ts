import { NotFoundException } from '@nestjs/common';
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

function service(photo: any, rows: CaveRow[] = [tempier19]) {
  const prisma = {
    $queryRaw: jest.fn(async () => rows),
    photo: { findUnique: jest.fn(async () => photo) },
    movement: { findMany: jest.fn(async () => []) },
  };
  return new CaveService(prisma as any);
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
    expect(r.wine).toEqual(tempier19);
    expect(r.movements).toEqual([]);
  });
});
