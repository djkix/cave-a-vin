import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../../lib/api-client';
import { VintagesSection } from './VintagesSection';

afterEach(() => vi.restoreAllMocks());

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VintagesSection />
    </QueryClientProvider>,
  );
}

it('liste les millésimes qualifiés', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Bordeaux', 'Rhône'], qualities: [{ region: 'Rhône', year: 2016, quality: 'GRAND' }] });
  mount();
  expect(await screen.findByText('Rhône 2016 — Grand')).toBeInTheDocument();
});

it('qualifie un millésime', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Bordeaux', 'Rhône'], qualities: [] });
  const put = vi.spyOn(api, 'putVintage').mockResolvedValue({ region: 'Rhône', year: 2016, quality: 'FAIBLE' });
  mount();
  await screen.findByLabelText('Région');
  await userEvent.selectOptions(screen.getByLabelText('Région'), 'Rhône');
  await userEvent.type(screen.getByLabelText('Année'), '2016');
  await userEvent.click(screen.getByRole('button', { name: 'Faible' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith({ region: 'Rhône', year: 2016, quality: 'FAIBLE' }));
});

it('n’envoie rien tant que l’année n’a pas quatre chiffres', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Rhône'], qualities: [] });
  mount();
  await screen.findByLabelText('Région');
  await userEvent.type(screen.getByLabelText('Année'), '201');
  expect(screen.getByRole('button', { name: 'Grand' })).toBeDisabled();
});

it('remet un millésime à « non qualifié »', async () => {
  vi.spyOn(api, 'getVintages').mockResolvedValue({ regions: ['Languedoc-Roussillon'], qualities: [{ region: 'Languedoc-Roussillon', year: 2016, quality: 'GRAND' }] });
  const del = vi.spyOn(api, 'deleteVintage').mockResolvedValue(undefined);
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Retirer Languedoc-Roussillon 2016' }));
  await waitFor(() => expect(del).toHaveBeenCalledWith('Languedoc-Roussillon', 2016));
});

it('encode une région accentuée ou à tiret dans l’adresse', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await api.deleteVintage('Rhône', 2016);
  await api.deleteVintage('Languedoc-Roussillon', 2016);
  expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/admin/vintages/Rh%C3%B4ne/2016', '/api/admin/vintages/Languedoc-Roussillon/2016']);
});
