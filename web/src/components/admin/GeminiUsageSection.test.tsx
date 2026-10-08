import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as api from '../../lib/api-client';
import { GeminiUsageSection } from './GeminiUsageSection';

afterEach(() => vi.restoreAllMocks());

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GeminiUsageSection />
    </QueryClientProvider>,
  );

const usage = (over: Partial<api.GeminiUsage> = {}): api.GeminiUsage => ({
  rows: [
    { day: '2026-10-08', usage: 'LECTURE_ENTREE', ok: 3, refused503: 2, refused429: 1, errors: 1, costCents: 12 },
    { day: '2026-10-07', usage: 'ACCORDS', ok: 5, refused503: 0, refused429: 0, errors: 0, costCents: 1 },
  ],
  totals: { ok: 8, refused: 3, errors: 1, costCents: 13 },
  pause: { until: null, reason: null },
  ...over,
});

it('affiche une ligne par jour et par usage, et les totaux', async () => {
  vi.spyOn(api, 'getGeminiUsage').mockResolvedValue(usage());
  mount();
  const row = (await screen.findByText('Lecture à l’entrée')).closest('tr')!;
  expect(within(row).getByText('08/10')).toBeInTheDocument();
  expect(within(row).getAllByRole('cell').map((c) => c.textContent?.replace(/\s/g, ' '))).toEqual(['08/10', 'Lecture à l’entrée', '3', '2', '1', '1', '0,12 €']);
  expect(screen.getByText('Accords').closest('tr')).toHaveTextContent('07/10');
  for (const h of ['Jour', 'Usage', 'Réussis', 'Refusés (saturé)', 'Refusés (quota)', 'Erreurs', 'Coût']) {
    expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
  }
  expect(screen.getByText(/Total : 8 réussis, 3 refusés, 1 erreur/)).toHaveTextContent('0,13 €');
  expect(screen.getByText(/compte dans ses statistiques de requêtes mais n'est pas facturé/)).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: /pause/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/aucun appel n'est envoyé/)).not.toBeInTheDocument();
});

it('annonce une pause en cours, heure de Paris', async () => {
  vi.spyOn(api, 'getGeminiUsage').mockResolvedValue(usage({ pause: { until: '2026-10-08T12:05:00.000Z', reason: 'modèle saturé' } }));
  mount();
  expect(await screen.findByText(`Gemini en pause jusqu'à 14:05 (modèle saturé) : aucun appel n'est envoyé d'ici là.`)).toBeInTheDocument();
});

it('7 jours par défaut, 30 jours au choix', async () => {
  const get = vi.spyOn(api, 'getGeminiUsage').mockResolvedValue(usage());
  mount();
  await screen.findByText('Accords');
  expect(get).toHaveBeenCalledWith(7);
  expect(screen.getByRole('button', { name: '7 jours' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '30 jours' }));
  await waitFor(() => expect(get).toHaveBeenCalledWith(30));
  expect(screen.getByRole('button', { name: '30 jours' })).toHaveAttribute('aria-pressed', 'true');
});

it('période vide : aucun tableau', async () => {
  vi.spyOn(api, 'getGeminiUsage').mockResolvedValueOnce(usage({ rows: [], totals: { ok: 0, refused: 0, errors: 0, costCents: 0 } }));
  mount();
  expect(await screen.findByText('Aucun appel à Gemini sur 7 jours.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('dit quand la consommation ne se charge pas', async () => {
  vi.spyOn(api, 'getGeminiUsage').mockRejectedValue(new Error('boom'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger la consommation Gemini.');
});
