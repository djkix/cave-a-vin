import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api-client';
import { PairingBlock, pairingPollInterval } from './PairingBlock';

afterEach(() => vi.restoreAllMocks());

const mount = (pairing: api.Pairing | null) =>
  render(<QueryClientProvider client={new QueryClient()}><PairingBlock wineId="w1" pairing={pairing} /></QueryClientProvider>);

it('montre les plats suggérés et leur origine', () => {
  mount({ status: 'DONE', dishes: ['Agneau de sept heures', 'Daube provençale'], errorMessage: null, generatedAt: '2026-10-05T10:00:00Z' });
  expect(screen.getByText('Agneau de sept heures')).toBeInTheDocument();
  expect(screen.getByText('Suggestions générées par Gemini')).toBeInTheDocument();
});

it('dit que les suggestions sont en préparation, sans accords ou en attente', () => {
  mount(null);
  expect(screen.getByText('Suggestions en préparation…')).toBeInTheDocument();
});

it('dit pourquoi les suggestions manquent, et relance la génération', async () => {
  const regen = vi.spyOn(api, 'regeneratePairing').mockResolvedValue(undefined);
  mount({ status: 'FAILED', dishes: [], errorMessage: 'Réponse de Gemini inexploitable', generatedAt: null });
  expect(screen.getByText('Suggestions indisponibles')).toBeInTheDocument();
  expect(screen.getByText('Réponse de Gemini inexploitable')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Régénérer' }));
  await waitFor(() => expect(regen).toHaveBeenCalledWith('w1'));
});

it('montre le motif de l’attente (ex. plafond partagé avec les photos) et permet de relancer un accord resté en attente', async () => {
  mount({ status: 'PENDING', dishes: [], errorMessage: 'Plafond mensuel de dépense vision atteint — saisie manuelle uniquement jusqu’au mois prochain', generatedAt: null });
  expect(screen.getByText('Suggestions en préparation…')).toBeInTheDocument();
  expect(screen.getByText('Plafond mensuel de dépense vision atteint — saisie manuelle uniquement jusqu’au mois prochain')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Régénérer' })).toBeInTheDocument();
});

it('ne propose pas de relance quand il n’existe encore aucune ligne d’accord', () => {
  mount(null);
  expect(screen.getByText('Suggestions en préparation…')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Régénérer' })).not.toBeInTheDocument();
});

it('rafraîchit la fiche toutes les 5 s tant que les suggestions sont en attente', () => {
  expect(pairingPollInterval(null)).toBe(5000);
  expect(pairingPollInterval({ status: 'PENDING', dishes: [], errorMessage: null, generatedAt: null })).toBe(5000);
  expect(pairingPollInterval({ status: 'DONE', dishes: ['x'], errorMessage: null, generatedAt: null })).toBe(false);
  expect(pairingPollInterval({ status: 'FAILED', dishes: [], errorMessage: 'x', generatedAt: null })).toBe(false);
});
