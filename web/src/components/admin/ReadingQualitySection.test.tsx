import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import * as api from '../../lib/api-client';
import { ReadingQualitySection } from './ReadingQualitySection';

afterEach(() => vi.restoreAllMocks());

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReadingQualitySection />
    </QueryClientProvider>,
  );

const fields = (vintage: number): api.ReadingQuality['fields'] => [
  { field: 'producer', corrected: 1, rate: 0.1 }, { field: 'cuvee', corrected: 0, rate: 0 },
  { field: 'appellationRaw', corrected: 0, rate: 0 }, { field: 'vintage', corrected: 3, rate: vintage },
  { field: 'color', corrected: 0, rate: 0 }, { field: 'formatCl', corrected: 0, rate: 0 },
];

it('affiche le taux sous l’objectif et le détail par champ', async () => {
  vi.spyOn(api, 'getReadingQuality').mockResolvedValue({ days: 90, entries: 10, rate: 0.0667, fields: fields(0.3) });
  mount();
  const summary = await screen.findByText(/7 % de champs corrigés à la main/);
  expect(summary).toHaveTextContent('10 entrées sur 90 jours');
  expect(screen.getByText('Objectif atteint (moins de 15 %)')).toBeInTheDocument();
  const row = screen.getByText('Millésime').closest('tr')!;
  expect(within(row).getByText('30 %')).toBeInTheDocument();
});

it('signale un taux au-dessus de l’objectif', async () => {
  vi.spyOn(api, 'getReadingQuality').mockResolvedValue({ days: 90, entries: 1, rate: 0.5, fields: fields(1) });
  mount();
  expect(await screen.findByText(/1 entrée sur 90 jours/)).toBeInTheDocument();
  expect(screen.getByText('Au-dessus de l’objectif (moins de 15 %)')).toBeInTheDocument();
});

it('dit quand aucune entrée n’est mesurée', async () => {
  vi.spyOn(api, 'getReadingQuality').mockResolvedValue({ days: 90, entries: 0, rate: null, fields: fields(0).map((f) => ({ ...f, rate: null, corrected: 0 })) });
  mount();
  expect(await screen.findByText('Aucune entrée par photo mesurée sur 90 jours.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('dit quand la mesure ne se charge pas', async () => {
  vi.spyOn(api, 'getReadingQuality').mockRejectedValue(new Error('boom'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger la mesure.');
});

it('juge l’objectif sur le pourcentage affiché', async () => {
  vi.spyOn(api, 'getReadingQuality').mockResolvedValue({ days: 90, entries: 20, rate: 0.1496, fields: fields(0.3) });
  mount();
  expect(await screen.findByText(/15 % de champs corrigés/)).toBeInTheDocument();
  expect(screen.getByText('Au-dessus de l’objectif (moins de 15 %)')).toBeInTheDocument();
});
