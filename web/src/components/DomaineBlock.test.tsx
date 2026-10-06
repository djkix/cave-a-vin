import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { DomaineBlock, producerPollInterval } from './DomaineBlock';

afterEach(() => vi.restoreAllMocks());

const mount = (producerKey: string | null, producerProfile: api.ProducerProfile | null | undefined) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DomaineBlock wineId="w1" producerKey={producerKey} producerProfile={producerProfile} />
    </QueryClientProvider>,
  );

const gemini = (overrides: Partial<api.ProducerProfile> = {}): api.ProducerProfile => ({
  key: 'domaine tempier', displayName: 'Domaine Tempier', status: 'DONE', description: 'Un domaine du Var…',
  source: 'GEMINI', errorMessage: null, generatedAt: '2026-10-05T10:00:00Z', updatedBy: null,
  ...overrides,
});

it('ne montre rien et ne demande rien quand le domaine n’a pas de clé', () => {
  const { container } = mount(null, null);
  expect(container).toBeEmptyDOMElement();
  expect(producerPollInterval(null, null)).toBe(false);
});

it('dit que le descriptif est en préparation quand il n’existe encore aucun profil', () => {
  mount('domaine tempier', null);
  expect(screen.getByText('Descriptif en préparation…')).toBeInTheDocument();
  expect(producerPollInterval('domaine tempier', null)).toBe(5000);
});

it('dit que le descriptif est en préparation tant que le statut est PENDING, sans texte', () => {
  mount('domaine tempier', gemini({ status: 'PENDING', description: null, generatedAt: null }));
  expect(screen.getByText('Descriptif en préparation…')).toBeInTheDocument();
});

it('montre l’ancien texte avec une note de régénération quand un nouveau descriptif est en préparation', () => {
  mount('domaine tempier', gemini({ status: 'PENDING' }));
  expect(screen.getByText('Un domaine du Var…')).toBeInTheDocument();
  expect(screen.getByText('Nouveau descriptif en préparation…')).toBeInTheDocument();
});

it('montre le texte généré par Gemini avec son avertissement, Modifier et Régénérer', async () => {
  const regen = vi.spyOn(api, 'regenerateProducer').mockResolvedValue(undefined);
  mount('domaine tempier', gemini());
  expect(screen.getByText('Un domaine du Var…')).toBeInTheDocument();
  expect(screen.getByText('Généré par Gemini, peut contenir des erreurs')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Modifier' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Régénérer' }));
  await waitFor(() => expect(regen).toHaveBeenCalledWith('domaine tempier'));
});

it('montre le texte saisi à la main avec son auteur, Modifier et « Revenir au texte généré »', async () => {
  const regen = vi.spyOn(api, 'regenerateProducer').mockResolvedValue(undefined);
  mount('domaine tempier', gemini({ source: 'MANUEL', updatedBy: 'Franck' }));
  expect(screen.getByText('Texte saisi par Franck')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Modifier' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Revenir au texte généré' }));
  await waitFor(() => expect(regen).toHaveBeenCalledWith('domaine tempier'));
});

it('propose d’écrire le descriptif quand le domaine est peu documenté, et de régénérer', async () => {
  const regen = vi.spyOn(api, 'regenerateProducer').mockResolvedValue(undefined);
  mount('domaine tempier', gemini({ status: 'UNKNOWN', description: null, source: 'GEMINI' }));
  expect(screen.getByText('Domaine peu documenté : Gemini n’a pas d’information fiable.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Écrire le descriptif' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Régénérer' }));
  await waitFor(() => expect(regen).toHaveBeenCalledWith('domaine tempier'));
});

it('dit pourquoi le descriptif manque et permet de régénérer ou d’écrire', () => {
  mount('domaine tempier', gemini({ status: 'FAILED', description: null, errorMessage: 'Réponse de Gemini inexploitable' }));
  expect(screen.getByText('Descriptif indisponible')).toBeInTheDocument();
  expect(screen.getByText('Réponse de Gemini inexploitable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Régénérer' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Écrire le descriptif' })).toBeInTheDocument();
});

it('montre le texte saisi à la main sans auteur quand le compte a été supprimé', () => {
  mount('domaine tempier', gemini({ source: 'MANUEL', updatedBy: null }));
  expect(screen.getByText('Texte saisi à la main')).toBeInTheDocument();
  expect(screen.queryByText(/null/)).not.toBeInTheDocument();
});

it('garde l’ancien texte visible quand une régénération a échoué', () => {
  mount('domaine tempier', gemini({ status: 'FAILED', description: 'Un domaine du Var…', errorMessage: 'Réponse de Gemini inexploitable' }));
  expect(screen.getByText('Un domaine du Var…')).toBeInTheDocument();
  expect(screen.getByText('Descriptif indisponible')).toBeInTheDocument();
  expect(screen.getByText('Réponse de Gemini inexploitable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Régénérer' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Écrire le descriptif' })).toBeInTheDocument();
});

it('autorise 2000 caractères utiles même entourés d’espaces, et compte la longueur sans espaces', async () => {
  mount('domaine tempier', gemini());
  await userEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  const textarea = screen.getByLabelText('Descriptif du domaine');
  await userEvent.clear(textarea);
  const padded = `  ${'x'.repeat(2000)}  `;
  fireEvent.change(textarea, { target: { value: padded } });
  expect(screen.getByText('2000 / 2000')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
});

it('édite et enregistre un descriptif, avec le compteur de caractères', async () => {
  const save = vi.spyOn(api, 'setProducerDescription').mockResolvedValue(gemini({ source: 'MANUEL', updatedBy: 'Franck', description: 'Nouveau texte' }));
  mount('domaine tempier', gemini());
  await userEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  const textarea = screen.getByLabelText('Descriptif du domaine');
  expect(textarea).toHaveValue('Un domaine du Var…');
  await userEvent.clear(textarea);
  await userEvent.type(textarea, 'Nouveau texte');
  expect(screen.getByText('13 / 2000')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('domaine tempier', 'Nouveau texte'));
});

it('désactive Enregistrer quand le texte est vide ou trop long', async () => {
  mount('domaine tempier', gemini());
  await userEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  const textarea = screen.getByLabelText('Descriptif du domaine');
  await userEvent.clear(textarea);
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await userEvent.type(textarea, 'x'.repeat(2001));
  expect(screen.getByText('2001 / 2000')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
});

it('abandonne l’édition sans rien envoyer', async () => {
  const save = vi.spyOn(api, 'setProducerDescription');
  mount('domaine tempier', gemini());
  await userEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  await userEvent.clear(screen.getByLabelText('Descriptif du domaine'));
  await userEvent.click(screen.getByRole('button', { name: 'Abandonner' }));
  expect(screen.queryByLabelText('Descriptif du domaine')).not.toBeInTheDocument();
  expect(screen.getByText('Un domaine du Var…')).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

it('affiche en clair une erreur de l’api lors de l’enregistrement', async () => {
  vi.spyOn(api, 'setProducerDescription').mockRejectedValue(new api.ApiError(400, 'Le descriptif doit faire entre 1 et 2000 caractères'));
  mount('domaine tempier', gemini());
  await userEvent.click(screen.getByRole('button', { name: 'Modifier' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Le descriptif doit faire entre 1 et 2000 caractères');
});

it('rafraîchit la fiche toutes les 5 s tant que le descriptif est en préparation, pas sinon', () => {
  expect(producerPollInterval('domaine tempier', null)).toBe(5000);
  expect(producerPollInterval('domaine tempier', gemini({ status: 'PENDING' }))).toBe(5000);
  expect(producerPollInterval('domaine tempier', gemini({ status: 'DONE' }))).toBe(false);
  expect(producerPollInterval('domaine tempier', gemini({ status: 'FAILED' }))).toBe(false);
  expect(producerPollInterval('domaine tempier', gemini({ status: 'UNKNOWN' }))).toBe(false);
  expect(producerPollInterval(null, null)).toBe(false);
});
