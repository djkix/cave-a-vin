import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieResolutionPage } from './SortieResolutionPage';

afterEach(() => vi.restoreAllMocks());

const cand = (id: string, vintage: number | null): api.ExitCandidate => ({
  wine: { id, producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage, color: 'ROUGE', formatCl: 75 },
  quantity: 2, referencePhotoId: `ref-${id}`, score: 0.9,
});
const read: api.ExitRead = { producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellation: 'Bandol', vintage: null };

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
