import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { QuoteBlock } from './QuoteBlock';

const SEARCH = 'https://www.idealwine.com/fr/prix-vin/domaine-tempier-la-tourtine-2019/le_marche_search/ok_results.jsp';
const PAGE = 'https://www.idealwine.com/fr/acheter-vin/tempier.jsp';
const quote: api.Quote = { coteCents: 8500, nTransactions: 12, quotedOn: '2026-03-03', sourceUrl: PAGE, enteredBy: 'Franck', cessionCents: 7140 };

beforeEach(() => {
  // Seule l'horloge est figée (le 8 octobre 2026 à Paris) : les saisies de userEvent restent réelles.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mount = (q: api.Quote | null, idealwineUrl = q?.sourceUrl ?? SEARCH) =>
  render(<QueryClientProvider client={new QueryClient()}><QuoteBlock wineId="w1" quote={q} idealwineUrl={idealwineUrl} /></QueryClientProvider>);

const expectExternal = (name: string, href: string) => {
  const link = screen.getByRole('link', { name });
  expect(link).toHaveAttribute('href', href);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
};

it('sans cote : « Pas encore de cote », le lien vers iDealwine et « Saisir la cote »', () => {
  mount(null);
  expect(screen.getByRole('heading', { name: 'Cote iDealwine' })).toBeInTheDocument();
  expect(screen.getByText('Pas encore de cote')).toBeInTheDocument();
  expectExternal('Voir la cote sur iDealwine', SEARCH);
  expect(screen.getByRole('button', { name: 'Saisir la cote' })).toBeInTheDocument();
  expect(screen.queryByText(/0 €/)).not.toBeInTheDocument();
});

it('avec cote : la ligne, la valeur de cession et sa note, « Voir sur iDealwine » et « Mettre à jour »', () => {
  mount(quote);
  expect(screen.getByText('85 € — 12 transactions — cote du 3 mars 2026, il y a 7 mois')).toBeInTheDocument();
  expect(screen.getByText('Valeur de cession estimée : 71 € (cote moins 16 % de frais acheteur)')).toBeInTheDocument();
  expectExternal('Voir sur iDealwine', PAGE);
  expect(screen.getByRole('button', { name: 'Mettre à jour' })).toBeInTheDocument();
  expect(screen.queryByText('Peu de transactions : ordre de grandeur')).not.toBeInTheDocument();
  expect(screen.queryByText("Cote de plus d'un an")).not.toBeInTheDocument();
});

it('avertit : peu de transactions, cote de plus d’un an', () => {
  mount({ ...quote, nTransactions: 3, quotedOn: '2025-09-01' });
  expect(screen.getByText('Peu de transactions : ordre de grandeur')).toBeInTheDocument();
  expect(screen.getByText("Cote de plus d'un an")).toBeInTheDocument();
  expect(screen.getByText('85 € — 3 transactions — cote du 1 septembre 2025, il y a 1 an')).toBeInTheDocument();
});

it('saisit une cote : euros en centimes, date du jour par défaut, lien vide quand rien n’est enregistré', async () => {
  const create = vi.spyOn(api, 'createQuote').mockResolvedValue(quote);
  mount(null);
  await userEvent.click(screen.getByRole('button', { name: 'Saisir la cote' }));
  expect(screen.getByLabelText('Date de la cote')).toHaveValue('2026-10-08');
  expect(screen.getByLabelText('Date de la cote')).toHaveAttribute('min', '1990-01-01');
  expect(screen.getByLabelText('Date de la cote')).toHaveAttribute('max', '2026-10-08');
  expect(screen.getByLabelText('Lien de la page iDealwine (facultatif)')).toHaveValue('');
  await userEvent.type(screen.getByLabelText('Cote en euros'), '85,50');
  await userEvent.type(screen.getByLabelText('Nombre de transactions (facultatif)'), '12');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la cote' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith('w1', { coteCents: 8550, nTransactions: 12, quotedOn: '2026-10-08', sourceUrl: null }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Enregistrer la cote' })).not.toBeInTheDocument());
});

it('« Mettre à jour » pré-remplit le lien enregistré, même venu d’une cote plus ancienne', async () => {
  const create = vi.spyOn(api, 'createQuote').mockResolvedValue(quote);
  // Cote courante sans lien : l'api renvoie celui d'une cote plus ancienne.
  mount({ ...quote, sourceUrl: null }, PAGE);
  await userEvent.click(screen.getByRole('button', { name: 'Mettre à jour' }));
  expect(screen.getByLabelText('Lien de la page iDealwine (facultatif)')).toHaveValue(PAGE);
  expect(screen.getByLabelText('Cote en euros')).toHaveValue('');
  await userEvent.type(screen.getByLabelText('Cote en euros'), '90');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la cote' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith('w1', { coteCents: 9000, nTransactions: null, quotedOn: '2026-10-08', sourceUrl: PAGE }));
});

it('bloque une cote ou un nombre de transactions invalide, avec le message de l’api', async () => {
  mount(null);
  await userEvent.click(screen.getByRole('button', { name: 'Saisir la cote' }));
  const save = screen.getByRole('button', { name: 'Enregistrer la cote' });
  expect(save).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Cote en euros'), '0');
  expect(screen.getByText('La cote doit être comprise entre 0,01 € et 100 000 €')).toBeInTheDocument();
  expect(save).toBeDisabled();
  await userEvent.clear(screen.getByLabelText('Cote en euros'));
  await userEvent.type(screen.getByLabelText('Cote en euros'), '85');
  expect(save).toBeEnabled();
  await userEvent.type(screen.getByLabelText('Nombre de transactions (facultatif)'), '2,5');
  expect(screen.getByText('Nombre de transactions invalide')).toBeInTheDocument();
  expect(save).toBeDisabled();
});

it('affiche l’erreur de l’api telle quelle et garde le formulaire', async () => {
  vi.spyOn(api, 'createQuote').mockRejectedValue(new api.ApiError(400, 'Le lien doit être une page www.idealwine.com'));
  mount(null);
  await userEvent.click(screen.getByRole('button', { name: 'Saisir la cote' }));
  await userEvent.type(screen.getByLabelText('Cote en euros'), '85');
  await userEvent.type(screen.getByLabelText('Lien de la page iDealwine (facultatif)'), 'https://example.com/');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la cote' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Le lien doit être une page www.idealwine.com');
  expect(screen.getByRole('button', { name: 'Enregistrer la cote' })).toBeInTheDocument();
});

it('« Abandonner » referme le formulaire', async () => {
  mount(quote);
  await userEvent.click(screen.getByRole('button', { name: 'Mettre à jour' }));
  await userEvent.click(screen.getByRole('button', { name: 'Abandonner' }));
  expect(screen.queryByLabelText('Cote en euros')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mettre à jour' })).toBeInTheDocument();
});
