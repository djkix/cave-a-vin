import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { viewerMe } from '../test-fixtures';
import { WinePage } from './WinePage';

afterEach(() => vi.restoreAllMocks());

const SEARCH = 'https://www.idealwine.com/fr/prix-vin/domaine-tempier-la-tourtine-2019/le_marche_search/ok_results.jsp';
const base: api.WineDetail = {
  wine: {
    id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 6,
    referencePhotoSource: null, referencePhotoSourceUrl: null, pairing: null, producerKey: null, producerProfile: null,
  },
  movements: [],
};
const viewerDetail = base;

let client: QueryClient;
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/cave/w1']}>
        <Routes><Route path="/cave/:wineId" element={<WinePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('propriétaire : bloc « Cote iDealwine » sans cote', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue({ ...base, quote: null, idealwineUrl: SEARCH, savedUrl: null });
  mount();
  expect(await screen.findByRole('heading', { name: 'Cote iDealwine' })).toBeInTheDocument();
  expect(screen.getByText('Pas encore de cote')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Voir la cote sur iDealwine (nouvel onglet)' })).toHaveAttribute('href', SEARCH);
});

it('propriétaire : bloc avec la cote courante', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue({
    ...base,
    quote: { coteCents: 8500, nTransactions: 12, quotedOn: '2026-03-03', sourceUrl: null, enteredBy: 'Franck', cessionCents: 7328 },
    idealwineUrl: SEARCH, savedUrl: null,
  });
  mount();
  expect(await screen.findByText(/^85 € — 12 transactions — cote du 3 mars 2026/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mettre à jour' })).toBeInTheDocument();
});

it('membre : aucun bloc de cote, aucune requête de cote', async () => {
  const me = vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  const create = vi.spyOn(api, 'createQuote');
  vi.spyOn(api, 'getWine').mockResolvedValue(viewerDetail);
  mount();
  expect(await screen.findByRole('heading', { name: /Domaine Tempier/ })).toBeInTheDocument();
  await waitFor(() => expect(me).toHaveBeenCalled());
  // Session chargée et page rendue avec le rôle de membre (avant, rien n'est autorisé : le test serait vide).
  await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('success'));
  expect(screen.queryByText('Cote iDealwine')).not.toBeInTheDocument();
  expect(screen.queryByText(/iDealwine|Pas encore de cote|cession/)).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
});

it('membre : même si des clés de cote arrivaient, rien n’est affiché', async () => {
  const me = vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  vi.spyOn(api, 'getWine').mockResolvedValue({ ...base, quote: null, idealwineUrl: SEARCH, savedUrl: null });
  mount();
  expect(await screen.findByRole('heading', { name: /Domaine Tempier/ })).toBeInTheDocument();
  await waitFor(() => expect(me).toHaveBeenCalled());
  // Session chargée et page rendue avec le rôle de membre (avant, rien n'est autorisé : le test serait vide).
  await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('success'));
  expect(screen.queryByText('Cote iDealwine')).not.toBeInTheDocument();
});

it('propriétaire, fiche sans clés de cote (ancienne api) : pas de bloc', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(viewerDetail);
  mount();
  expect(await screen.findByRole('heading', { name: /Domaine Tempier/ })).toBeInTheDocument();
  expect(screen.queryByText('Cote iDealwine')).not.toBeInTheDocument();
});
