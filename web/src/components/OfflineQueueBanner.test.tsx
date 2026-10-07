import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import * as api from '../lib/api-client';
import { _resetForTests, enqueuePhoto } from '../lib/offline-queue';
import { viewerMe } from '../test-fixtures';
import { OfflineQueueBanner } from './OfflineQueueBanner';

const blob = () => new Blob([new Uint8Array(4)], { type: 'image/jpeg' });

beforeEach(() => _resetForTests());
afterEach(() => vi.restoreAllMocks());

function mount(readOnly = false) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OfflineQueueBanner readOnly={readOnly} />
    </QueryClientProvider>,
  );
}

it('signale discrètement les photos d’un autre compte, sans les compter comme siennes', async () => {
  await enqueuePhoto(blob(), 'entry', 'u2');
  await enqueuePhoto(blob(), 'entry', 'u2');
  mount();
  expect(await screen.findByText('Photos en attente d’un autre compte : 2')).toBeInTheDocument();
  expect(screen.queryByText(/en cours d’envoi/)).not.toBeInTheDocument();
});

it('compte ses photos et les photos anciennes sans estampille', async () => {
  await enqueuePhoto(blob(), 'entry', 'u1');
  await enqueuePhoto(blob(), 'entry');
  await enqueuePhoto(blob(), 'entry', 'u2');
  mount();
  expect(await screen.findByText('2 photos en cours d’envoi')).toBeInTheDocument();
  expect(screen.getByText('Photos en attente d’un autre compte : 1')).toBeInTheDocument();
});

it('en lecture seule, ne montre que la note, sans bouton d’envoi', async () => {
  await enqueuePhoto(blob(), 'entry', 'u1');
  await enqueuePhoto(blob(), 'entry', 'u2');
  mount(true);
  expect(await screen.findByText('Photos en attente d’un autre compte : 1')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText(/en cours d’envoi/)).not.toBeInTheDocument();
});

it('dans une cave où l’on n’est que membre, signale ses propres photos en attente, sans bouton d’envoi', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  await enqueuePhoto(blob(), 'entry', 'u1');
  await enqueuePhoto(blob(), 'entry', 'u1');
  mount(true);
  expect(await screen.findByText('2 photos en attente : elles partiront quand votre cave sera sélectionnée')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('accorde la note au singulier pour une seule photo', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  await enqueuePhoto(blob(), 'entry', 'u1');
  mount(true);
  expect(await screen.findByText('1 photo en attente : elle partira quand votre cave sera sélectionnée')).toBeInTheDocument();
});

it('sans photo à soi, pas de note de membre', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  await enqueuePhoto(blob(), 'entry', 'u2');
  mount(true);
  expect(await screen.findByText('Photos en attente d’un autre compte : 1')).toBeInTheDocument();
  expect(screen.queryByText(/quand votre cave sera sélectionnée/)).not.toBeInTheDocument();
});
