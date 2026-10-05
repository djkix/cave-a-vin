import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { StatsPage } from './StatsPage';

afterEach(() => vi.restoreAllMocks());

const months = (overrides: Record<string, [number, number]> = {}) =>
  ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
    .map((month) => ({ month, in: overrides[month]?.[0] ?? 0, out: overrides[month]?.[1] ?? 0 }));

const base: api.Stats = {
  bottles: 12, references: 2, pricedReferences: 1, purchaseValueCents: 1240000,
  byColor: [{ key: 'ROUGE', bottles: 9, share: 0.75 }, { key: 'BLANC', bottles: 3, share: 0.25 }],
  byRegion: [{ key: 'Rhône', bottles: 9, share: 0.75 }, { key: 'Sans région', bottles: 3, share: 0.25 }],
  byDecade: [{ key: '2010', bottles: 9, share: 0.75 }, { key: 'Non millésimé', bottles: 3, share: 0.25 }],
  byApogee: [
    { key: 'TROP_JEUNE', bottles: 0, share: 0 }, { key: 'A_BOIRE', bottles: 6, share: 0.5 }, { key: 'A_BOIRE_VITE', bottles: 3, share: 0.25 },
    { key: 'PASSEE', bottles: 0, share: 0 }, { key: 'SANS_ESTIMATION', bottles: 3, share: 0.25 },
  ],
  months: months({ '2026-10': [6, 1] }), drinkRate: 0.8, yearsLeft: 1,
  mostDrunk: [{ id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', vintage: 2019, value: 3 }],
  topProducers: [{ producer: 'Domaine Tempier', bottles: 9 }],
  mostExpensive: [{ id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', vintage: 2019, value: 4800 }],
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><StatsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

it('affiche bouteilles, références et valeur au prix d’achat, avec la part valorisée', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  expect(await screen.findByText(/~12\s400\s€/)).toBeInTheDocument();
  expect(screen.getByText('sur 1 des 2 références')).toBeInTheDocument();
  expect(screen.getByText('12')).toBeInTheDocument();
});

it('dit qu’aucun prix d’achat n’est saisi', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue({ ...base, purchaseValueCents: null, pricedReferences: 0 });
  mount();
  expect(await screen.findByText('Aucun prix d’achat saisi')).toBeInTheDocument();
});

it('mène des barres d’apogée vers la cave filtrée', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  expect(await screen.findByRole('link', { name: /À boire vite/ })).toHaveAttribute('href', '/cave?filtre=priorite');
  expect(screen.getByRole('link', { name: /Sans estimation/ })).toHaveAttribute('href', '/cave?filtre=sans-apogee');
  const heading = screen.getByRole('heading', { name: 'Apogée' });
  const card = within(heading.closest('section')!);
  // Passée et Trop jeune n'ont aucune bouteille dans le jeu de données : pas de lien pour elles.
  expect(card.getAllByRole('link')).toHaveLength(2);
});

it('montre les 8 premières régions puis « Autres »', async () => {
  const byRegion = Array.from({ length: 10 }, (_, i) => ({ key: `Région ${i + 1}`, bottles: 100 - i, share: (100 - i) / 955 }));
  vi.spyOn(api, 'getStats').mockResolvedValue({ ...base, byRegion });
  mount();
  const card = (await screen.findByRole('heading', { name: 'Région' })).closest('section')!;
  expect(within(card).getByText('Région 8')).toBeInTheDocument();
  expect(within(card).queryByText('Région 9')).not.toBeInTheDocument();
  expect(within(card).getByText('Autres')).toBeInTheDocument();
  expect(within(card).getByText(/^183 ·/)).toBeInTheDocument(); // 92 + 91 bouteilles
});

it('décrit chaque mois de l’histogramme et le rythme de consommation', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  expect(await screen.findByLabelText('octobre 2026 : 6 entrées, 1 sortie')).toBeInTheDocument();
  expect(screen.getByText('En moyenne 0,8 bouteille bue par mois — environ 1 an de cave à ce rythme')).toBeInTheDocument();
});

it('sans sortie sur 12 mois, ne promet aucune durée', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue({ ...base, months: months({ '2026-03': [12, 0] }), drinkRate: 0, yearsLeft: null, mostDrunk: [] });
  mount();
  expect(await screen.findByText('Aucune bouteille sortie sur 12 mois')).toBeInTheDocument();
});

it('mène des classements vers la fiche du vin', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue(base);
  mount();
  const card = (await screen.findByRole('heading', { name: 'Les plus chères' })).closest('section')!;
  expect(within(card).getByRole('link', { name: /Domaine Tempier — La Tourtine 2019/ })).toHaveAttribute('href', '/cave/w1');
  expect(within(card).getByText('~48 €')).toBeInTheDocument();
});

it('dit quand la cave est vide', async () => {
  vi.spyOn(api, 'getStats').mockResolvedValue({
    ...base, bottles: 0, references: 0, pricedReferences: 0, purchaseValueCents: null, byColor: [], byRegion: [], byDecade: [],
    byApogee: base.byApogee.map((a) => ({ ...a, bottles: 0, share: 0 })), months: months(), drinkRate: 0, yearsLeft: null,
    mostDrunk: [], topProducers: [], mostExpensive: [],
  });
  mount();
  expect(await screen.findByText('Aucune bouteille en cave pour l’instant')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Apogée' })).not.toBeInTheDocument();
});

it('dit quand les statistiques ne se chargent pas', async () => {
  vi.spyOn(api, 'getStats').mockRejectedValue(new Error('boom'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les statistiques.');
});
