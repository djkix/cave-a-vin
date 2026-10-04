import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieResolutionPage } from './SortieResolutionPage';

afterEach(() => vi.restoreAllMocks());

const cand = (id: string, vintage: number | null, formatCl = 75): api.ExitCandidate => ({
  wine: { id, producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage, color: 'ROUGE', formatCl },
  quantity: 2, referencePhotoId: `ref-${id}`, score: 0.9,
});
const read: api.ExitRead = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', vintage: null };

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sortie/p1']}>
        <Routes>
          <Route path="/sortie/:photoId" element={<SortieResolutionPage />} />
          <Route path="/cave" element={<p>Cave</p>} />
          <Route path="/entree" element={<p>Entrée</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('va droit à la confirmation quand le vin est reconnu sans ambiguïté', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'UNIQUE', read, candidates: [cand('w19', 2019)] });
  mount();
  expect(await screen.findByRole('button', { name: /Sortir 1 bouteille/ })).toBeInTheDocument();
  expect(screen.getByText(/2019/)).toBeInTheDocument();
});

it('fait choisir le millésime quand plusieurs vins sont proches, puis confirme', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'SEVERAL', read, candidates: [cand('w19', 2019), cand('w20', 2020)] });
  mount();
  expect(await screen.findByText('Lequel est-ce ?')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Sortir 1 bouteille/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /2020/ }));
  expect(await screen.findByRole('button', { name: /Sortir 1 bouteille/ })).toBeInTheDocument();
});

it('permet de revenir sur le choix du millésime après un tapotement sur un mauvais candidat', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'SEVERAL', read, candidates: [cand('w19', 2019), cand('w20', 2020)] });
  const createOut = vi.spyOn(api, 'createOut');
  mount();
  expect(await screen.findByText('Lequel est-ce ?')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /2020/ }));
  expect(await screen.findByRole('button', { name: /Sortir 1 bouteille/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Choisir un autre millésime' }));
  expect(await screen.findByText('Lequel est-ce ?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /2019/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /2020/ })).toBeInTheDocument();
  expect(createOut).not.toHaveBeenCalled();
});

it('propose de chercher (recherche pré-remplie) ou de rentrer le vin quand il n’est pas dans la cave', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'NONE', read, candidates: [] });
  mount();
  expect(await screen.findByText('Ce vin n’est pas dans la cave')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toHaveAttribute('href', '/cave?q=Domaine%20Tempier%20La%20Tourtine');
  expect(screen.getByRole('link', { name: 'Rentrer ce vin' })).toHaveAttribute('href', '/entree');
});

it('bascule tout de suite sur la recherche quand l’analyse échoue', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'FAILED', errorMessage: 'saturé' });
  mount();
  expect(await screen.findByText('Lecture impossible')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toHaveAttribute('href', '/cave');
});

it('propose la recherche au bout de douze secondes sans résultat', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'PROCESSING' });
    mount();
    expect(await screen.findByText(/Lecture de l’étiquette/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Chercher dans la cave' })).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getByRole('link', { name: 'Chercher dans la cave' })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

const outResult = (stock: number): api.MovementResult => ({
  movement: { id: 'm1', delta: -1, type: 'OUT', occurredAt: '' },
  wine: { id: 'w19', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75 },
  stock,
  created: true,
});

it('retire « Choisir un autre millésime » une fois la sortie faite', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({ status: 'DONE', outcome: 'SEVERAL', read, candidates: [cand('w19', 2019), cand('w20', 2020)] });
  vi.spyOn(api, 'createOut').mockResolvedValue(outResult(1));
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /2019/ }));
  expect(screen.getByRole('button', { name: 'Choisir un autre millésime' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  expect(await screen.findByText('Sorti — il en reste 1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Choisir un autre millésime' })).not.toBeInTheDocument();
});

it('garde le résultat et « Annuler » quand un rafraîchissement ne trouve plus le vin sorti jusqu’à la dernière bouteille', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const candidates = vi
    .spyOn(api, 'getExitCandidates')
    .mockResolvedValue({ status: 'DONE', outcome: 'UNIQUE', read, candidates: [{ ...cand('w19', 2019), quantity: 1 }] });
  vi.spyOn(api, 'createOut').mockResolvedValue(outResult(0));
  mount(client);
  await userEvent.click(await screen.findByRole('button', { name: /Sortir 1 bouteille/ }));
  expect(await screen.findByText('Sorti — il en reste 0')).toBeInTheDocument();
  // Retour sur l'application : le vin, à zéro, ne fait plus partie des candidats.
  candidates.mockResolvedValue({ status: 'DONE', outcome: 'NONE', read, candidates: [] });
  await act(async () => {
    await client.refetchQueries({ queryKey: ['exit-candidates', 'p1'] });
  });
  // TanStack Query notifie les composants au tick suivant : on le laisse passer.
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(screen.queryByText('Ce vin n’est pas dans la cave')).not.toBeInTheDocument();
  expect(screen.getByText('Sorti — il en reste 0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Annuler la sortie' })).toBeInTheDocument();
});

it('affiche le format sous le millésime pour distinguer bouteille et magnum', async () => {
  vi.spyOn(api, 'getExitCandidates').mockResolvedValue({
    status: 'DONE', outcome: 'SEVERAL', read, candidates: [cand('w75', 2019, 75), cand('w150', 2019, 150)],
  });
  mount();
  expect(await screen.findByRole('button', { name: /2019.*75 cl/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /2019.*150 cl/ })).toBeInTheDocument();
});
