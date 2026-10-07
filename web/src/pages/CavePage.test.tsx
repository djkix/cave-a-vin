import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { CavePage } from './CavePage';

afterEach(() => vi.restoreAllMocks());

const rows: api.CaveRow[] = [
  { id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 3, apogee: { min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' } },
  { id: 'w2', producer: 'Domaine Leflaive', cuvee: null, appellationRaw: 'Puligny-Montrachet', vintage: 2020, color: 'BLANC', formatCl: 75, referencePhotoId: null, quantity: 1 },
];

function mount(url = '/cave') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/cave" element={<CavePage />} />
          <Route path="/cave/:wineId" element={<p>Fiche</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('liste les vins en stock avec leur quantité et un lien vers la fiche', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  expect(await screen.findByText(/Domaine Tempier/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Domaine Tempier.*2019/ })).toHaveAttribute('href', '/cave/w1');
  expect(screen.getByText('3')).toBeInTheDocument();
});

it('affiche un pictogramme, jamais une image cassée, pour un vin sans photo', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  const { container } = mount();
  await screen.findByText(/Domaine Leflaive/);
  expect(container.querySelectorAll('img')).toHaveLength(1);
  expect(screen.getByLabelText('Pas de photo')).toBeInTheDocument();
});

it('transmet la recherche pré-remplie par l’URL', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount('/cave?q=tempier');
  await waitFor(() => expect(getCave).toHaveBeenCalledWith({ q: 'tempier', color: undefined, includeEmpty: false }));
  expect(screen.getByLabelText('Rechercher')).toHaveValue('tempier');
});

it('filtre par couleur et montre les épuisés sur demande', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  await screen.findByText(/Domaine Tempier/);
  await userEvent.selectOptions(screen.getByLabelText('Couleur'), 'BLANC');
  await userEvent.click(screen.getByLabelText('Afficher les vins épuisés'));
  await waitFor(() => expect(getCave).toHaveBeenLastCalledWith({ q: '', color: 'BLANC', includeEmpty: true }));
});

it('montre la note sur la ligne d’un vin noté', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([{ ...rows[0], rating: { value: 16.5, ratedAt: '2026-10-05T10:00:00Z', ratedBy: null } }]);
  mount();
  const row = await screen.findByRole('link', { name: /Domaine Tempier/ });
  expect(within(row).getByText('16,5/20')).toBeInTheDocument();
});

it('affiche la couleur du vin sur sa ligne', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  await screen.findByText(/Domaine Leflaive/);
  const row = screen.getByRole('link', { name: /Leflaive/ });
  expect(within(row).getByText(/Blanc/)).toBeInTheDocument();
});

it('montre une mention d’apogée sur la ligne', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  const row = await screen.findByRole('link', { name: /Domaine Tempier/ });
  expect(within(row).getByText('À boire 2024-2036')).toBeInTheDocument();
});

it('limite la longueur du plat recherché', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue(rows);
  mount();
  await screen.findByText(/Domaine Tempier/);
  expect(screen.getByLabelText('Accompagner un plat')).toHaveAttribute('maxLength', '100');
});

it('cherche un vin pour accompagner un plat et dit lequel correspond', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockImplementation(async (f) =>
    f.dish ? [{ ...rows[0], matchedDish: 'Agneau de sept heures' }] : rows,
  );
  mount();
  await screen.findByText(/Domaine Leflaive/);
  await userEvent.type(screen.getByLabelText('Accompagner un plat'), 'agneau');
  await waitFor(() => expect(getCave).toHaveBeenLastCalledWith(expect.objectContaining({ dish: 'agneau' })));
  const row = await screen.findByRole('link', { name: /Domaine Tempier/ });
  expect(within(row).getByText('avec : Agneau de sept heures')).toBeInTheDocument();
  expect(screen.queryByText(/Domaine Leflaive/)).not.toBeInTheDocument();
});

it('dit quand la cave est vide', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount();
  expect(await screen.findByText(/Aucun vin ne correspond/)).toBeInTheDocument();
});

const nv: api.CaveRow = {
  id: 'w3', producer: 'Champagne Essai', cuvee: null, appellationRaw: 'Champagne', vintage: null, color: 'PETILLANT', formatCl: 75, referencePhotoId: null, quantity: 2,
  apogee: { min: null, max: null, confidence: null, status: null, reason: 'NON_MILLESIME', source: null },
};

it('filtre « à boire en priorité » et signale les vins sans apogée, avec un lien vers eux', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockImplementation(async (f) => (f.noApogee ? [nv] : rows));
  mount();
  await screen.findByText(/Domaine Tempier/);
  expect(screen.queryByText(/sans apogée estimée/)).not.toBeInTheDocument();
  expect(getCave).not.toHaveBeenCalledWith(expect.objectContaining({ noApogee: true }));
  await userEvent.click(screen.getByLabelText('À boire en priorité'));
  await waitFor(() => expect(getCave).toHaveBeenCalledWith({ q: '', color: undefined, includeEmpty: false, drinkSoon: true }));
  expect(await screen.findByText('1 vin sans apogée estimée')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'À compléter' }));
  expect(screen.getByLabelText('Sans apogée')).toBeChecked();
  expect(screen.getByLabelText('À boire en priorité')).not.toBeChecked();
  expect(await screen.findByRole('link', { name: /Champagne Essai/ })).toBeInTheDocument();
  expect(screen.queryByText(/sans apogée estimée/)).not.toBeInTheDocument();
});

it('ne coche jamais les deux filtres d’apogée ensemble', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount();
  await userEvent.click(screen.getByLabelText('Sans apogée'));
  await userEvent.click(screen.getByLabelText('À boire en priorité'));
  expect(screen.getByLabelText('Sans apogée')).not.toBeChecked();
  await waitFor(() => expect(getCave).toHaveBeenCalledWith(expect.objectContaining({ drinkSoon: true })));
  expect(getCave).not.toHaveBeenCalledWith(expect.objectContaining({ drinkSoon: true, noApogee: true }));
  await userEvent.click(screen.getByLabelText('À boire en priorité'));
  expect(screen.getByLabelText('À boire en priorité')).not.toBeChecked();
  expect(screen.getByLabelText('Sans apogée')).not.toBeChecked();
});

it('coche « À boire en priorité » depuis l\'URL', async () => {
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue([]);
  mount('/cave?filtre=priorite');
  expect(screen.getByLabelText('À boire en priorité')).toBeChecked();
  await waitFor(() => expect(getCave).toHaveBeenCalledWith({ q: '', color: undefined, includeEmpty: false, drinkSoon: true }));
});

it('coche « Sans apogée » depuis l\'URL, et ignore une valeur inconnue', async () => {
  vi.spyOn(api, 'getCave').mockResolvedValue([]);
  const { unmount } = mount('/cave?filtre=sans-apogee');
  expect(screen.getByLabelText('Sans apogée')).toBeChecked();
  unmount();
  mount('/cave?filtre=nimporte');
  expect(screen.getByLabelText('À boire en priorité')).not.toBeChecked();
  expect(screen.getByLabelText('Sans apogée')).not.toBeChecked();
});

it('filtre par emplacement, « Sans emplacement » compris', async () => {
  // Même si l'api joignait les emplacements aux lignes, la liste ne les affiche pas (fiche seulement).
  const withPlaces = rows.map((r) => ({ ...r, locations: [{ id: 'l1', label: 'Cave 2 / B / 3', quantity: r.quantity }], locationLabel: 'Cave 2 / B / 3' }));
  const getCave = vi.spyOn(api, 'getCave').mockResolvedValue(withPlaces);
  vi.spyOn(api, 'getLocations').mockResolvedValue([
    { id: 'l1', zone: 'Cave 2', casier: 'B', position: '3', label: 'Cave 2 / B / 3', lastUsed: false },
    { id: 'l2', zone: 'Garage', casier: null, position: null, label: 'Garage', lastUsed: true },
  ]);
  mount();
  await screen.findByText(/Domaine Tempier/);
  const select = screen.getByLabelText('Emplacement') as HTMLSelectElement;
  await waitFor(() => expect([...select.options].map((o) => o.text)).toEqual(['Tous', 'Cave 2 / B / 3', 'Garage', 'Sans emplacement']));
  await userEvent.selectOptions(select, 'Garage');
  await waitFor(() => expect(getCave).toHaveBeenLastCalledWith({ q: '', color: undefined, includeEmpty: false, location: 'l2' }));
  await userEvent.selectOptions(select, 'Sans emplacement');
  await waitFor(() => expect(getCave).toHaveBeenLastCalledWith({ q: '', color: undefined, includeEmpty: false, location: 'none' }));
  // La ligne d'un vin n'affiche pas ses emplacements (fiche seulement).
  for (const link of screen.getAllByRole('link')) expect(link).not.toHaveTextContent('Cave 2 / B / 3');
  expect(screen.getAllByRole('link', { name: /Domaine/ })).toHaveLength(2);
});

it('passe le filtre d’emplacement dans l’adresse de l’api', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
  await api.getCave({ location: 'none' });
  expect(fetchSpy.mock.calls[0][0]).toBe('/api/cave?location=none');
});
