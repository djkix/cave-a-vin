import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../lib/api-client';
import * as sse from '../lib/sse';
import { EntreeConfirmationPage } from './EntreeConfirmationPage';

afterEach(() => vi.restoreAllMocks());

const extraction: api.WineExtraction = {
  producer: { value: 'Domaine Tempier', confidence: 0.98 }, cuvee: { value: 'La Tourtine', confidence: 0.95 },
  appellation: { value: 'Bandol', confidence: 0.97 }, vintage: { value: 2019, confidence: 0.5 },
  color: { value: 'ROUGE', confidence: 0.99 }, formatCl: { value: 75, confidence: 0.9 },
  bottlesPerCase: { value: 6, confidence: 0.85 }, globalConfidence: 0.93,
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/entree/p1']}>
        <Routes>
          <Route path="/entree/:photoId" element={<EntreeConfirmationPage />} />
          <Route path="/" element={<p>Accueil</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('waits for extraction, prefills the form, then writes one IN movement on confirm', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'PENDING', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation((_id, onEvent) => { onEvent({ status: 'DONE', extraction }); return () => {}; });
  const create = vi.spyOn(api, 'createMovement').mockResolvedValue({ movement: { id: 'm1', delta: 6, type: 'IN', occurredAt: '' }, wine: { id: 'w1', producer: 'Domaine Tempier', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 6, created: true });

  mount();
  expect(await screen.findByDisplayValue('Domaine Tempier')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^6/ })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(screen.getByRole('button', { name: /Confirmer l’entrée \(\+6 bouteilles\)/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const input = create.mock.calls[0][0];
  expect(input.quantity).toBe(6);
  expect(input.photoId).toBe('p1');
  expect(input.wine.producer).toBe('Domaine Tempier');
  expect(input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText(/Stock : 6/)).toBeInTheDocument();
});

it('shows the failure and a manual-entry fallback when extraction fails', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'FAILED', errorMessage: 'Plafond mensuel atteint', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
  mount();
  expect(await screen.findByText(/Plafond mensuel atteint/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Saisir à la main/ })).toBeInTheDocument();
});

it('shows a fetch error (404/offline) as a failure with a manual-entry fallback', async () => {
  vi.spyOn(api, 'getPhoto').mockRejectedValue(new api.ApiError(404, 'Photo introuvable'));
  mount();
  expect(await screen.findByText(/Photo introuvable/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Saisir à la main/ })).toBeInTheDocument();
});

it('annonce un report, sans échec, quand le worker a remis la photo en attente', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({
    id: 'p1',
    status: 'PENDING',
    errorMessage: 'Analyse reportée : service Gemini momentanément saturé, reprise automatique',
    createdAt: '',
  });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
  mount();
  expect(await screen.findByText(/service Gemini momentanément saturé/)).toBeInTheDocument();
  expect(screen.getByText('Analyse reportée')).toBeInTheDocument();
  expect(screen.queryByText(/Lecture impossible/)).not.toBeInTheDocument();
  // Les deux sorties : partir en laissant la photo en file, ou saisir tout de suite.
  expect(screen.getByRole('button', { name: /Terminer, j’attends l’analyse/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Saisir à la main/ })).toBeInTheDocument();
});

it('libère l’écran au bout de vingt secondes d’attente sans nouvelle', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'PROCESSING', createdAt: '' });
    vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
    mount();
    expect(await screen.findByText(/Analyse de l’étiquette en cours/)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('Analyse reportée')).toBeInTheDocument();
    expect(screen.getByText(/Ta photo est enregistrée sur le serveur/)).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('falls back to manual entry when the event stream drops', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'PENDING', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation((_id, _onEvent, onError) => {
    onError?.();
    return () => {};
  });
  mount();
  expect(await screen.findByText(/Connexion au serveur interrompue/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Saisir à la main/ })).toBeInTheDocument();
});

it('truncates a very long failure message to one readable line', async () => {
  const long = `Plafond mensuel atteint : ${'x'.repeat(400)}`;
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'FAILED', errorMessage: long, createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
  mount();
  const shown = await screen.findByText(/^Plafond mensuel atteint/);
  expect(shown.textContent).toHaveLength(161);
  expect(shown.textContent?.endsWith('…')).toBe(true);
});

it('prefills the form for a photo already DONE at load, via the SSE snapshot', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'DONE', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation((_id, onEvent) => { onEvent({ status: 'DONE', extraction }); return () => {}; });
  mount();
  expect(await screen.findByDisplayValue('Domaine Tempier')).toBeInTheDocument();
});

it('sends a single movement on a rapid double tap of Confirmer', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'PENDING', createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation((_id, onEvent) => { onEvent({ status: 'DONE', extraction }); return () => {}; });
  const create = vi.spyOn(api, 'createMovement').mockImplementation(
    () => new Promise((resolve) => {
      setTimeout(() => resolve({ movement: { id: 'm1', delta: 6, type: 'IN', occurredAt: '' }, wine: { id: 'w1', producer: 'Domaine Tempier', appellationRaw: 'Bandol', color: 'ROUGE', formatCl: 75 }, stock: 6, created: true }), 20);
    }),
  );

  mount();
  await screen.findByDisplayValue('Domaine Tempier');
  const button = screen.getByRole('button', { name: /Confirmer l’entrée/ });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/Stock : 6/)).toBeInTheDocument();
});

it('pré-remplit la fiche depuis la photo déjà lue, même sans nouvelle du flux', async () => {
  vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'DONE', extraction, createdAt: '' });
  vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
  mount();
  expect(await screen.findByDisplayValue('Domaine Tempier')).toBeInTheDocument();
});

describe('emplacement à l’entrée', () => {
  const locations: api.Location[] = [
    { id: 'l0', zone: 'Armoire', casier: null, position: null, label: 'Armoire', lastUsed: false },
    { id: 'l1', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3', lastUsed: true },
  ];
  const ok = { movement: { id: 'm1', delta: 6, type: 'IN', occurredAt: '' }, wine: { id: 'w1', producer: 'Domaine Tempier', appellationRaw: 'Bandol', color: 'ROUGE' as const, formatCl: 75 }, stock: 6, created: true };

  function ready() {
    vi.spyOn(api, 'getPhoto').mockResolvedValue({ id: 'p1', status: 'DONE', extraction, createdAt: '' });
    vi.spyOn(sse, 'subscribePhotoEvents').mockImplementation(() => () => {});
  }

  function mountWithClient() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const view = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/entree/p1']}>
          <Routes><Route path="/entree/:photoId" element={<EntreeConfirmationPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { ...view, invalidate };
  }

  it('replie le bloc, le pré-remplit avec l’emplacement « lastUsed » du serveur, l’envoie et rafraîchit les emplacements', async () => {
    ready();
    vi.spyOn(api, 'getLocations').mockResolvedValue(locations);
    const recent = vi.spyOn(api, 'getRecentMovements');
    const create = vi.spyOn(api, 'createMovement').mockResolvedValue(ok);
    const { container, invalidate } = mountWithClient();
    await screen.findByDisplayValue('Domaine Tempier');
    expect(await screen.findByText('Cave 2 / B / 3')).toBeInTheDocument();
    const block = [...container.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent?.startsWith('Emplacement'))!;
    expect(block).not.toHaveAttribute('open');
    expect(recent).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Confirmer l’entrée/ }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].location).toEqual({ zone: 'Cave 2', casier: 'B', position: '3' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['locations'] }));
  });

  it('ne laisse pas confirmer tant que les emplacements ne sont pas lus', async () => {
    ready();
    vi.spyOn(api, 'getLocations').mockImplementation(() => new Promise(() => {}));
    mount();
    await screen.findByDisplayValue('Domaine Tempier');
    expect(screen.getByRole('button', { name: /Confirmer l’entrée/ })).toBeDisabled();
  });

  // Client aux réglages par défaut (3 nouvelles tentatives, ~7 s) : l'entrée ne doit jamais attendre si longtemps.
  function mountWithRetries() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/entree/p1']}>
          <Routes><Route path="/entree/:photoId" element={<EntreeConfirmationPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('emplacements illisibles : « Confirmer » revient dès l’erreur, sans nouvelles tentatives, et l’entrée part sans emplacement', async () => {
    ready();
    const list = vi.spyOn(api, 'getLocations').mockRejectedValue(new api.ApiError(500, 'Erreur'));
    const create = vi.spyOn(api, 'createMovement').mockResolvedValue(ok);
    mountWithRetries();
    await screen.findByDisplayValue('Domaine Tempier');
    const button = screen.getByRole('button', { name: /Confirmer l’entrée/ });
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 900 });
    expect(list).toHaveBeenCalledTimes(1);
    await userEvent.click(button);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].location).toBeNull();
  });

  it('emplacements sans réponse : « Confirmer » revient au bout de 2 s, et l’entrée part sans emplacement', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      ready();
      vi.spyOn(api, 'getLocations').mockImplementation(() => new Promise(() => {}));
      const create = vi.spyOn(api, 'createMovement').mockResolvedValue(ok);
      mountWithRetries();
      await screen.findByDisplayValue('Domaine Tempier');
      const button = screen.getByRole('button', { name: /Confirmer l’entrée/ });
      expect(button).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0][0].location).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('envoie null (« Sans emplacement ») quand les champs sont vidés', async () => {
    ready();
    vi.spyOn(api, 'getLocations').mockResolvedValue(locations);
    const create = vi.spyOn(api, 'createMovement').mockResolvedValue(ok);
    mount();
    await screen.findByText('Cave 2 / B / 3');
    await userEvent.click(screen.getByText('Emplacement'));
    for (const label of ['Zone', 'Casier', 'Position']) await userEvent.clear(screen.getByLabelText(label));
    expect(screen.getByText('Sans emplacement')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Confirmer l’entrée/ }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].location).toBeNull();
  });

  it('affiche telle quelle l’erreur de l’API sur l’emplacement', async () => {
    ready();
    vi.spyOn(api, 'getLocations').mockResolvedValue([]);
    vi.spyOn(api, 'createMovement').mockRejectedValue(new api.ApiError(400, '40 caractères au plus par champ d\'emplacement'));
    mount();
    await screen.findByDisplayValue('Domaine Tempier');
    await userEvent.click(screen.getByText('Emplacement'));
    await userEvent.type(screen.getByLabelText('Zone'), 'Cellier');
    await userEvent.click(await screen.findByRole('button', { name: /Confirmer l’entrée/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('40 caractères au plus par champ d\'emplacement');
  });
});
