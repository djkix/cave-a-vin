import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { AnalysisQueueBanner } from './AnalysisQueueBanner';

afterEach(() => vi.restoreAllMocks());

function mount(props: { hideLink?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AnalysisQueueBanner {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('annonce les photos en attente avec le motif du dernier report', async () => {
  vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({
    waiting: 2,
    oldestWaitingAt: '2026-09-21T10:00:00Z',
    lastReason: 'Analyse reportée : service Gemini momentanément saturé, reprise automatique',
  });
  mount();
  expect(await screen.findByText(/2 photos en attente d’analyse/)).toBeInTheDocument();
  expect(screen.getByText(/momentanément saturé/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Voir la revue/ })).toBeInTheDocument();
});

it('accorde le singulier et se passe de motif quand il n’y en a pas', async () => {
  vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({ waiting: 1, oldestWaitingAt: null, lastReason: null });
  mount();
  expect(await screen.findByText(/1 photo en attente d’analyse/)).toBeInTheDocument();
  expect(screen.getByText(/dès que le service de lecture répond/)).toBeInTheDocument();
});

it('disparaît quand la file est vide', async () => {
  const status = vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({ waiting: 0, oldestWaitingAt: null, lastReason: null });
  const { container } = mount();
  await waitFor(() => expect(status).toHaveBeenCalled());
  expect(container.querySelector('.banner')).toBeNull();
});

it('masque le lien vers la revue quand on y est déjà', async () => {
  vi.spyOn(api, 'getPhotoQueueStatus').mockResolvedValue({ waiting: 3, oldestWaitingAt: null, lastReason: null });
  mount({ hideLink: true });
  expect(await screen.findByText(/3 photos en attente d’analyse/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Voir la revue/ })).not.toBeInTheDocument();
});
