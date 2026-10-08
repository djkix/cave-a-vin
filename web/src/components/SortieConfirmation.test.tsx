import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { SortieConfirmation } from './SortieConfirmation';

afterEach(() => vi.restoreAllMocks());

const wine: api.CaveRow = {
  id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019,
  color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 3,
};
const result = (stock: number): api.MovementResult => ({
  movement: { id: 'm1', delta: -1, type: 'OUT', occurredAt: '' }, wine: { ...wine, cuvee: wine.cuvee }, stock, created: true,
});

// Par défaut, endroits connus et vides (rien à demander) : la fiche n'est pas relue.
// Les cas de la sortie par photo passent `places: undefined`.
function mount(props: Partial<Parameters<typeof SortieConfirmation>[0]> = {}, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  props = { places: [], ...props };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SortieConfirmation wine={wine} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('sort une bouteille par défaut et annonce le stock restant', async () => {
  const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
  mount({ photoId: 'px' });
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  await waitFor(() => expect(out).toHaveBeenCalledTimes(1));
  expect(out.mock.calls[0][0]).toMatchObject({ wineId: 'w1', quantity: 1, photoId: 'px' });
  expect(out.mock.calls[0][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('Sorti — il en reste 2')).toBeInTheDocument();
});

it('borne la quantité au stock', async () => {
  mount();
  const more = screen.getByRole('button', { name: 'Une bouteille de plus' });
  await userEvent.click(more);
  await userEvent.click(more);
  await userEvent.click(more);
  expect(screen.getByRole('button', { name: /Sortir 3 bouteilles/ })).toBeInTheDocument();
  expect(more).toBeDisabled();
});

it('envoie une seule sortie sur un double tap', async () => {
  const out = vi.spyOn(api, 'createOut').mockImplementation(() => new Promise((r) => setTimeout(() => r(result(2)), 20)));
  mount();
  const button = screen.getByRole('button', { name: /Sortir 1 bouteille/ });
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText('Sorti — il en reste 2');
  expect(out).toHaveBeenCalledTimes(1);
});

it('affiche en clair un stock devenu insuffisant, sans rien sortir', async () => {
  vi.spyOn(api, 'createOut').mockRejectedValue(new api.ApiError(409, 'Il n’en reste que 0'));
  mount();
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Il n’en reste que 0');
  expect(screen.queryByText(/Sorti —/)).not.toBeInTheDocument();
});

it('annule la sortie depuis le message de résultat', async () => {
  vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
  const cancel = vi.spyOn(api, 'cancelMovement').mockResolvedValue(result(3));
  mount();
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Annuler la sortie' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('m1', expect.stringMatching(/^[0-9a-f-]{36}$/)));
  expect(await screen.findByText('Sortie annulée — 3 en stock')).toBeInTheDocument();
});

it('dit « Déjà sortie » quand le serveur rejoue une sortie existante, et garde Annuler', async () => {
  vi.spyOn(api, 'createOut').mockResolvedValue({ ...result(2), created: false });
  mount({ photoId: 'px' });
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  expect(await screen.findByText('Déjà sortie — il en reste 2')).toBeInTheDocument();
  expect(screen.queryByText(/^Sorti —/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Annuler la sortie' })).toBeInTheDocument();
});

it('affiche le refus d’une photo qui a déjà sorti un autre vin, sans rien annoncer de sorti', async () => {
  vi.spyOn(api, 'createOut').mockRejectedValue(
    new api.ApiError(409, 'Cette photo a déjà servi à sortir un autre vin — annulez d’abord cette sortie'),
  );
  mount({ photoId: 'px' });
  await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Cette photo a déjà servi à sortir un autre vin — annulez d’abord cette sortie');
  expect(screen.queryByText(/^(Sorti|Déjà sortie) —/)).not.toBeInTheDocument();
});

describe('d’où sort-elle ?', () => {
  const places: api.Place[] = [
    { id: 'l1', label: 'Cave 2 / B / 3', quantity: 2 },
    { id: 'l2', label: 'Garage', quantity: 1 },
    { id: null, label: 'Sans emplacement', quantity: 1 },
  ];

  it('demande l’endroit avec les quantités, pré-sélectionne le plus probable et l’envoie', async () => {
    const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(3));
    mount({ wine: { ...wine, quantity: 4 }, places, exitDefault: 'l2' });
    const group = screen.getByRole('group', { name: 'D\'où sort-elle ?' });
    expect(within(group).getByRole('radio', { name: 'Cave 2 / B / 3 · 2' })).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Garage · 1' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Sans emplacement · 1' })).toBeInTheDocument();
    // La quantité est bornée au stock de l'endroit choisi.
    expect(screen.getByRole('button', { name: 'Une bouteille de plus' })).toBeDisabled();
    await userEvent.click(within(group).getByRole('radio', { name: 'Sans emplacement · 1' }));
    await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
    await waitFor(() => expect(out).toHaveBeenCalledTimes(1));
    expect(out.mock.calls[0][0]).toMatchObject({ wineId: 'w1', quantity: 1, locationId: null });
  });

  it('envoie la pré-sélection sans que l’on touche à rien', async () => {
    const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(3));
    mount({ wine: { ...wine, quantity: 4 }, places, exitDefault: 'l1' });
    await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
    await waitFor(() => expect(out.mock.calls[0][0]).toMatchObject({ locationId: 'l1' }));
  });

  it('ne pose pas la question quand le vin n’est qu’à un endroit', async () => {
    const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
    mount({ places: [{ id: 'l1', label: 'Cave 2 / B / 3', quantity: 3 }], exitDefault: 'l1' });
    expect(screen.queryByRole('group', { name: 'D\'où sort-elle ?' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
    await waitFor(() => expect(out.mock.calls[0][0]).toMatchObject({ locationId: 'l1' }));
  });

  it('lit les endroits sur la fiche quand on ne les lui donne pas (sortie par photo)', async () => {
    const getWine = vi.spyOn(api, 'getWine').mockResolvedValue({
      wine: { ...wine, quantity: 4, referencePhotoSource: null, referencePhotoSourceUrl: null, producerKey: null }, movements: [], locations: places, exitDefault: null,
    });
    mount({ wine: { ...wine, quantity: 4 }, photoId: 'px', places: undefined });
    const group = await screen.findByRole('group', { name: 'D\'où sort-elle ?' });
    expect(getWine).toHaveBeenCalledWith('w1');
    expect(within(group).getByRole('radio', { name: 'Sans emplacement · 1' })).toBeChecked();
  });

  it('affiche tel quel le 409 de l’endroit vide', async () => {
    vi.spyOn(api, 'createOut').mockRejectedValue(new api.ApiError(409, 'Pas assez de bouteilles à cet emplacement'));
    mount({ wine: { ...wine, quantity: 4 }, places, exitDefault: 'l2' });
    await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pas assez de bouteilles à cet emplacement');
  });

  it('après le 409 de l’endroit vide, relit la fiche pour montrer les quantités à jour', async () => {
    vi.spyOn(api, 'createOut').mockRejectedValue(new api.ApiError(409, 'Pas assez de bouteilles à cet emplacement'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mount({ wine: { ...wine, quantity: 4 }, places, exitDefault: 'l2' }, client);
    await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
    await screen.findByRole('alert');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['wine', 'w1'] });
  });

  it('sortie par photo, après le 409 de l’endroit vide : les endroits sont relus', async () => {
    const getWine = vi.spyOn(api, 'getWine').mockResolvedValue({
      wine: { ...wine, quantity: 4, referencePhotoSource: null, referencePhotoSourceUrl: null, producerKey: null }, movements: [], locations: places, exitDefault: null,
    });
    vi.spyOn(api, 'createOut').mockRejectedValue(new api.ApiError(409, 'Pas assez de bouteilles à cet emplacement'));
    mount({ wine: { ...wine, quantity: 4 }, photoId: 'px', places: undefined });
    await screen.findByRole('group', { name: 'D\'où sort-elle ?' });
    expect(getWine).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /Sortir 1 bouteille/ }));
    await screen.findByRole('alert');
    await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
  });

  it('sortie par photo, fiche illisible : pas de nouvelles tentatives, « Sortir » revient dès l’erreur', async () => {
    const getWine = vi.spyOn(api, 'getWine').mockRejectedValue(new api.ApiError(500, 'Erreur'));
    mount({ photoId: 'px', places: undefined }, new QueryClient());
    await waitFor(() => expect(screen.getByRole('button', { name: /Sortir 1 bouteille/ })).toBeEnabled(), { timeout: 900 });
    expect(getWine).toHaveBeenCalledTimes(1);
  });

  it('sortie par photo, fiche sans réponse : « Sortir » revient au bout de 2 s et part sans locationId', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'getWine').mockImplementation(() => new Promise(() => {}));
      const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
      mount({ photoId: 'px', places: undefined }, new QueryClient());
      const button = screen.getByRole('button', { name: /Sortir 1 bouteille/ });
      expect(button).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(out).toHaveBeenCalledTimes(1));
      expect(out.mock.calls[0][0]).not.toHaveProperty('locationId');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sortie par photo : « Sortir » attend la lecture de la fiche', async () => {
    vi.spyOn(api, 'getWine').mockImplementation(() => new Promise(() => {}));
    const out = vi.spyOn(api, 'createOut');
    mount({ photoId: 'px', places: undefined });
    const button = screen.getByRole('button', { name: /Sortir 1 bouteille/ });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(out).not.toHaveBeenCalled();
  });

  it('sortie par photo, fiche illisible : « Sortir » reste possible, sans locationId', async () => {
    vi.spyOn(api, 'getWine').mockRejectedValue(new api.ApiError(500, 'Erreur'));
    const out = vi.spyOn(api, 'createOut').mockResolvedValue(result(2));
    mount({ photoId: 'px', places: undefined });
    const button = screen.getByRole('button', { name: /Sortir 1 bouteille/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(out).toHaveBeenCalledTimes(1));
    expect(out.mock.calls[0][0]).not.toHaveProperty('locationId');
  });
});
