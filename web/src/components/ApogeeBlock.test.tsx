import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { ApogeeBlock } from './ApogeeBlock';

afterEach(() => vi.restoreAllMocks());

const base: api.CaveRow = {
  id: 'w1', producer: 'Château de Beaucastel', cuvee: null, appellationRaw: 'Châteauneuf-du-Pape', vintage: 2016,
  color: 'ROUGE', formatCl: 75, referencePhotoId: null, quantity: 2,
  apogee: { min: 2024, max: 2036, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' },
};

function mount(wine: api.CaveRow = base) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApogeeBlock wine={wine} />
    </QueryClientProvider>,
  );
}

it('affiche la fourchette, la confiance et le statut', () => {
  mount();
  expect(screen.getByText('À boire entre 2024 et 2036')).toBeInTheDocument();
  expect(screen.getByText('Confiance faible')).toBeInTheDocument();
  expect(screen.getByText('À boire — jusqu’en 2036')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revenir à l’estimation' })).not.toBeInTheDocument();
});

it('explique l’absence d’estimation et propose la saisie', () => {
  mount({ ...base, vintage: null, apogee: { min: null, max: null, confidence: null, status: null, reason: 'NON_MILLESIME', source: null } });
  expect(screen.getByText('Vin non millésimé : saisis la fourchette si tu la connais')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Corriger' })).toBeInTheDocument();
});

it('enregistre une correction', async () => {
  const set = vi.spyOn(api, 'setApogee').mockResolvedValue({ min: 2030, max: 2035, confidence: 'SAISIE', status: 'TROP_JEUNE', reason: null, source: 'MANUEL' });
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Corriger' }));
  await userEvent.clear(screen.getByLabelText('Année de début'));
  await userEvent.type(screen.getByLabelText('Année de début'), '2030');
  await userEvent.clear(screen.getByLabelText('Année de fin'));
  await userEvent.type(screen.getByLabelText('Année de fin'), '2035');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’apogée' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith('w1', { min: 2030, max: 2035 }));
});

it('refuse une fin avant le début sans rien envoyer', async () => {
  const set = vi.spyOn(api, 'setApogee');
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Corriger' }));
  await userEvent.clear(screen.getByLabelText('Année de début'));
  await userEvent.type(screen.getByLabelText('Année de début'), '2040');
  expect(screen.getByText('L’année de début doit précéder ou égaler l’année de fin')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer l’apogée' })).toBeDisabled();
  expect(set).not.toHaveBeenCalled();
});

it('revient à l’estimation quand la fourchette est saisie', async () => {
  const clear = vi.spyOn(api, 'clearApogee').mockResolvedValue(base.apogee!);
  mount({ ...base, apogee: { min: 2030, max: 2035, confidence: 'SAISIE', status: 'TROP_JEUNE', reason: null, source: 'MANUEL' } });
  expect(screen.getByText('Saisie')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Revenir à l’estimation' }));
  await waitFor(() => expect(clear).toHaveBeenCalledWith('w1'));
});

it('affiche en clair une erreur de l’api', async () => {
  vi.spyOn(api, 'setApogee').mockRejectedValue(new api.ApiError(400, 'Année de fin trop lointaine'));
  mount();
  await userEvent.click(screen.getByRole('button', { name: 'Corriger' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’apogée' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Année de fin trop lointaine');
});
