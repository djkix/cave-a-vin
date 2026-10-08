import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { AConfirmerPage } from './AConfirmerPage';

afterEach(() => vi.restoreAllMocks());

const ext = (producer: string, conf: number, qty: number | null): api.WineExtraction => ({
  producer: { value: producer, confidence: conf }, cuvee: { value: null, confidence: 0 }, appellation: { value: 'Bandol', confidence: conf },
  vintage: { value: 2019, confidence: conf }, color: { value: 'ROUGE', confidence: 1 }, formatCl: { value: 75, confidence: 1 },
  bottlesPerCase: { value: qty, confidence: 0.8 }, globalConfidence: conf,
});

const done = (id: string, extraction: api.WineExtraction): api.PhotoDto => ({ id, status: 'DONE', createdAt: '', extraction });

const okResult = (idempotencyKey: string): api.BulkResult[number] => ({
  ok: true, idempotencyKey,
  result: { movement: { id: 'm', delta: 12, type: 'IN', occurredAt: '' }, wine: { id: 'w', producer: 'Domaine Sûr', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 12, created: true },
});

function inbox(partial: Partial<api.EntryInbox>): api.EntryInbox {
  return { toConfirm: [], inProgress: [], failed: [], ...partial };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AConfirmerPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

const section = (name: RegExp) => screen.getByRole('region', { name });

it('montre les trois sections : à valider, en cours d’analyse, lecture impossible', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-done', ext('Domaine Sûr', 0.95, 12))],
    inProgress: [
      { id: 'p-wait', status: 'PENDING', createdAt: '' },
      { id: 'p-late', status: 'PROCESSING', createdAt: '', errorMessage: 'Analyse reportée : service saturé' },
    ],
    failed: [{ id: 'p-ko', status: 'FAILED', createdAt: '', errorMessage: 'Étiquette illisible' }],
  }));
  renderPage();
  expect(await screen.findByDisplayValue('Domaine Sûr')).toBeInTheDocument();
  expect(within(section(/À valider/)).getAllByRole('article')).toHaveLength(1);
  const progress = section(/En cours d’analyse/);
  expect(within(progress).getByText('Analyse en cours (environ 1 min)')).toBeInTheDocument();
  expect(within(progress).getByText('Analyse reportée : service saturé')).toBeInTheDocument();
  const failed = section(/Lecture impossible/);
  expect(within(failed).getByText('Étiquette illisible')).toBeInTheDocument();
  expect(within(failed).getByRole('link', { name: /Saisir à la main/ })).toHaveAttribute('href', '/entree/p-ko');
  expect(within(failed).getByRole('button', { name: /Écarter/ })).toBeInTheDocument();
});

it('pré-remplit la quantité lue, sinon 1', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-12', ext('Domaine Sûr', 0.95, 12)), done('p-1', ext('Domaine Seul', 0.9, null))],
  }));
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => items.map((i) => okResult(i.idempotencyKey)));
  renderPage();
  await screen.findAllByRole('article');
  await userEvent.click(screen.getByRole('button', { name: /Tout valider/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const byPhoto = Object.fromEntries(bulk.mock.calls[0][0].map((i) => [i.photoId, i.quantity]));
  expect(byPhoto).toEqual({ 'p-12': 12, 'p-1': 1 });
});

it('valide une seule fiche et rafraîchit la liste, la cave et le journal', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-a', ext('Domaine A', 0.95, 6)), done('p-b', ext('Domaine B', 0.95, 12))],
  }));
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => items.map((i) => okResult(i.idempotencyKey)));
  const { invalidate } = renderPage();
  await screen.findAllByRole('article');
  const card = screen.getAllByRole('article').find((a) => within(a).queryByDisplayValue('Domaine B'))!;
  await userEvent.click(within(card).getByRole('button', { name: /^Valider$/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const items = bulk.mock.calls[0][0];
  expect(items).toHaveLength(1);
  expect(items[0].photoId).toBe('p-b');
  expect(items[0].quantity).toBe(12);
  await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
  expect(screen.getByDisplayValue('Domaine A')).toBeInTheDocument();
  const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  expect(keys).toEqual(expect.arrayContaining(['["entry-inbox"]', '["cave"]', '["movements"]', '["stats"]', '["locations"]']));
});

it('liste la confiance la plus basse en premier et « Tout valider » envoie les fiches gardées', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-high', ext('Domaine Sûr', 0.95, 12)), done('p-low', ext('Domaine Douteux', 0.4, null))],
  }));
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => items.map((i) => okResult(i.idempotencyKey)));
  renderPage();
  const rows = await screen.findAllByRole('article');
  expect(within(rows[0]).getByDisplayValue('Domaine Douteux')).toBeInTheDocument();
  await userEvent.click(within(rows[0]).getByRole('button', { name: /Mettre de côté/ }));
  await userEvent.click(screen.getByRole('button', { name: /Tout valider \(1\)/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const items = bulk.mock.calls[0][0];
  expect(items).toHaveLength(1);
  expect(items[0].photoId).toBe('p-high');
  expect(await screen.findByText(/1 fiche validée/)).toBeInTheDocument();
});

it('garde une fiche modifiée telle quelle quand la liste se rafraîchit', async () => {
  const get = vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))] }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AConfirmerPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  const field = await screen.findByDisplayValue('Domaine A');
  await userEvent.clear(field);
  await userEvent.type(field, 'Domaine Corrigé');
  await qc.refetchQueries({ queryKey: ['entry-inbox'] });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(screen.getByDisplayValue('Domaine Corrigé')).toBeInTheDocument();
});

it('signale une fiche incomplète, ne la rend pas validable et la laisse hors de « Tout valider »', async () => {
  const incomplete = ext('Domaine Sûr', 0.4, null);
  incomplete.producer = { value: null, confidence: 0.4 };
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-ok', ext('Domaine Sûr', 0.95, 12)), done('p-incomplete', incomplete)],
  }));
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => items.map((i) => okResult(i.idempotencyKey)));
  renderPage();
  await screen.findAllByRole('article');
  const card = screen.getByText('Producteur requis').closest('article')!;
  expect(within(card).getByRole('button', { name: /^Valider$/ })).toBeDisabled();
  expect(screen.getByText(/1 fiche incomplète/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Tout valider \(1\)/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const items = bulk.mock.calls[0][0];
  expect(items).toHaveLength(1);
  expect(items[0].photoId).toBe('p-ok');
});

it('écarte une fiche à valider et une photo illisible', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))],
    failed: [{ id: 'p-ko', status: 'FAILED', createdAt: '', errorMessage: 'Étiquette illisible' }],
  }));
  const dismiss = vi.spyOn(api, 'dismissPhoto').mockResolvedValue({ ok: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { invalidate } = renderPage();
  const card = (await screen.findAllByRole('article'))[0];
  await userEvent.click(within(card).getByRole('button', { name: /Écarter/ }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith('p-a'));
  await waitFor(() => expect(screen.queryByDisplayValue('Domaine A')).not.toBeInTheDocument());
  await userEvent.click(within(section(/Lecture impossible/)).getByRole('button', { name: /Écarter/ }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith('p-ko'));
  await waitFor(() => expect(screen.queryByText('Étiquette illisible')).not.toBeInTheDocument());
  const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  expect(keys).toEqual(expect.arrayContaining(['["entry-inbox"]', '["cave"]', '["movements"]']));
});

it('demande confirmation avant d’écarter : annuler ne fait rien', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))],
    failed: [{ id: 'p-ko', status: 'FAILED', createdAt: '', errorMessage: 'Étiquette illisible' }],
  }));
  const dismiss = vi.spyOn(api, 'dismissPhoto').mockResolvedValue({ ok: true });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  renderPage();
  const card = (await screen.findAllByRole('article'))[0];
  await userEvent.click(within(card).getByRole('button', { name: /Écarter/ }));
  await userEvent.click(within(section(/Lecture impossible/)).getByRole('button', { name: /Écarter/ }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledWith('Écarter cette photo ? Elle ne sera plus proposée.');
  expect(dismiss).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue('Domaine A')).toBeInTheDocument();
  expect(screen.getByText('Étiquette illisible')).toBeInTheDocument();
});

it('écarte après confirmation acceptée', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))] }));
  const dismiss = vi.spyOn(api, 'dismissPhoto').mockResolvedValue({ ok: true });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderPage();
  const card = (await screen.findAllByRole('article'))[0];
  await userEvent.click(within(card).getByRole('button', { name: /Écarter/ }));
  expect(confirm).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith('p-a'));
});

it('nomme le vin dans le libellé de chaque bouton « Écarter », sinon « cette photo »', async () => {
  const unnamed = ext('Domaine B', 0.4, null);
  unnamed.producer = { value: null, confidence: 0.4 };
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-a', ext('Domaine A', 0.95, 6)), done('p-b', unnamed)],
    failed: [{ id: 'p-ko', status: 'FAILED', createdAt: '', errorMessage: 'Étiquette illisible' }],
  }));
  renderPage();
  await screen.findAllByRole('article');
  expect(screen.getByRole('button', { name: 'Écarter Domaine A 2019' })).toBeInTheDocument();
  expect(within(section(/À valider/)).getByRole('button', { name: 'Écarter cette photo' })).toBeInTheDocument();
  expect(within(section(/Lecture impossible/)).getByRole('button', { name: 'Écarter cette photo' })).toBeInTheDocument();
});

it('« Mettre de côté » retire la fiche de « Tout valider » pour cette visite seulement', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))] }));
  const dismiss = vi.spyOn(api, 'dismissPhoto');
  renderPage();
  const card = (await screen.findAllByRole('article'))[0];
  expect(screen.queryByRole('button', { name: /Ignorer/ })).not.toBeInTheDocument();
  await userEvent.click(within(card).getByRole('button', { name: 'Mettre de côté' }));
  expect(screen.getByRole('button', { name: /Tout valider \(0\)/ })).toBeDisabled();
  expect(screen.getByText(/les fiches mises de côté restent à confirmer/)).toBeInTheDocument();
  expect(dismiss).not.toHaveBeenCalled();
  await userEvent.click(within(card).getByRole('button', { name: 'Reprendre' }));
  expect(screen.getByRole('button', { name: /Tout valider \(1\)/ })).toBeEnabled();
});

it('affiche le refus d’écarter une photo déjà utilisée', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))] }));
  vi.spyOn(api, 'dismissPhoto').mockRejectedValue(new api.ApiError(409, 'Photo déjà utilisée par une entrée'));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderPage();
  const card = (await screen.findAllByRole('article'))[0];
  await userEvent.click(within(card).getByRole('button', { name: /Écarter/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Photo déjà utilisée par une entrée');
  expect(screen.getByDisplayValue('Domaine A')).toBeInTheDocument();
});

it('affiche l’erreur d’envoi et garde les fiches quand la validation échoue', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-high', ext('Domaine Sûr', 0.95, 12))] }));
  vi.spyOn(api, 'createMovementsBulk').mockRejectedValue(new api.ApiError(400, 'Liste de mouvements invalide'));
  renderPage();
  await screen.findAllByRole('article');
  await userEvent.click(screen.getByRole('button', { name: /Tout valider/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Liste de mouvements invalide');
  expect(screen.getAllByRole('article')).toHaveLength(1);
});

it('montre l’erreur propre à une fiche refusée', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-high', ext('Domaine Sûr', 0.95, 12))] }));
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => [
    { ok: false, idempotencyKey: items[0].idempotencyKey, error: 'Vin en conflit' },
  ]);
  renderPage();
  await screen.findAllByRole('article');
  await userEvent.click(screen.getByRole('button', { name: /Tout valider/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Vin en conflit')).toBeInTheDocument();
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('0 fiche validée · 1 en erreur');
  expect(status).toHaveClass('badge--warn');
});

it('annonce une liste vide', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({}));
  renderPage();
  expect(await screen.findByText(/Aucun vin à confirmer/)).toBeInTheDocument();
});

it('pré-remplit l’emplacement de chaque fiche et l’envoie avec la fiche', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({
    toConfirm: [done('p-a', ext('Domaine A', 0.95, 6)), done('p-b', ext('Domaine B', 0.95, 12))],
  }));
  vi.spyOn(api, 'getLocations').mockResolvedValue([{ id: 'l1', zoneId: 'z1', zone: 'Garage', casier: null, position: null, label: 'Garage', lastUsed: true }]);
  vi.spyOn(api, 'getZones').mockResolvedValue([{ id: 'z1', name: 'Garage', indication: null, hasPhoto: false, sortOrder: 0 }]);
  const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => items.map((i) => okResult(i.idempotencyKey)));
  renderPage();
  await screen.findAllByRole('article');
  await waitFor(() => expect(screen.getAllByText('Garage', { selector: '.location-block__current' })).toHaveLength(2));
  const cardB = screen.getAllByRole('article').find((a) => within(a).queryByDisplayValue('Domaine B'))!;
  await userEvent.click(within(cardB).getByText('Emplacement'));
  await userEvent.selectOptions(within(cardB).getByLabelText('Zone'), 'Sans zone');
  await userEvent.type(within(cardB).getByLabelText('Casier'), 'C');
  await userEvent.click(screen.getByRole('button', { name: /Tout valider/ }));
  await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
  const byPhoto = Object.fromEntries(bulk.mock.calls[0][0].map((i) => [i.photoId, i.location]));
  expect(byPhoto).toEqual({ 'p-a': { zoneId: 'z1', casier: null, position: null }, 'p-b': { zoneId: null, casier: 'C', position: null } });
});

it('ne laisse pas valider tant que les emplacements ne sont pas lus', async () => {
  vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))] }));
  vi.spyOn(api, 'getLocations').mockImplementation(() => new Promise(() => {}));
  renderPage();
  await screen.findAllByRole('article');
  expect(screen.getByRole('button', { name: /^Valider$/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Tout valider/ })).toBeDisabled();
});

describe('emplacements illisibles ou sans réponse : la validation n’attend jamais plus de 2 s', () => {
  // Client aux réglages par défaut (3 nouvelles tentatives, ~7 s).
  function renderWithRetries() {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><AConfirmerPage /></MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('erreur : les boutons reviennent dès l’erreur, sans nouvelles tentatives', async () => {
    vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))] }));
    const list = vi.spyOn(api, 'getLocations').mockRejectedValue(new api.ApiError(500, 'Erreur'));
    const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => items.map((i) => okResult(i.idempotencyKey)));
    renderWithRetries();
    await screen.findAllByRole('article');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Valider$/ })).toBeEnabled(), { timeout: 900 });
    expect(list).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /^Valider$/ }));
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    expect(bulk.mock.calls[0][0][0].location).toBeNull();
  });

  it('sans réponse : les boutons reviennent au bout de 2 s, fiches envoyées sans emplacement', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'getEntryInbox').mockResolvedValue(inbox({ toConfirm: [done('p-a', ext('Domaine A', 0.95, 6))] }));
      vi.spyOn(api, 'getLocations').mockImplementation(() => new Promise(() => {}));
      const bulk = vi.spyOn(api, 'createMovementsBulk').mockImplementation(async (items) => items.map((i) => okResult(i.idempotencyKey)));
      renderWithRetries();
      await screen.findAllByRole('article');
      const all = screen.getByRole('button', { name: /Tout valider/ });
      expect(all).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(all).toBeEnabled();
      expect(screen.getByRole('button', { name: /^Valider$/ })).toBeEnabled();
      fireEvent.click(all);
      await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
      expect(bulk.mock.calls[0][0][0].location).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
