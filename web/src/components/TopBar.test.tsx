import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import * as api from '../lib/api-client';
import { APP_VERSION } from '../lib/version';
import { meFixture, OWNER_CAVE, VIEWER_CAVE, viewerMe } from '../test-fixtures';
import { TopBar } from './TopBar';

afterEach(() => vi.restoreAllMocks());

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function mount(props: { title?: string; back?: string } = {}, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <TopBar {...props} />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

it('affiche la version sur l’écran d’accueil', () => {
  mount();
  expect(screen.getByLabelText(`Version ${APP_VERSION}`)).toHaveTextContent(`v${APP_VERSION}`);
});

it('affiche la version aussi sur un écran interne, avec son bouton de retour', () => {
  mount({ title: 'Revue groupée', back: '/entree' });
  expect(screen.getByRole('link', { name: 'Retour' })).toBeInTheDocument();
  expect(screen.getByLabelText(`Version ${APP_VERSION}`)).toBeInTheDocument();
});

it('annonce « dev » quand aucune version n’a été injectée à la construction', () => {
  // Les tests tournent sans VITE_APP_VERSION : c'est exactement le cas d'une
  // construction locale, qui ne doit jamais afficher un numéro inventé.
  expect(APP_VERSION).toBe('dev');
});

it('ne montre pas de sélecteur ni de badge à un propriétaire d’une seule cave', async () => {
  const me = vi.spyOn(api, 'getMe').mockResolvedValue(meFixture());
  mount();
  await waitFor(() => expect(me).toHaveBeenCalled());
  expect(screen.queryByRole('combobox', { name: 'Cave' })).not.toBeInTheDocument();
  expect(screen.queryByText('Lecture seule')).not.toBeInTheDocument();
});

it('signale la lecture seule à un membre d’une seule cave', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
  mount();
  expect(await screen.findByText('Lecture seule')).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Cave' })).not.toBeInTheDocument();
});

const twoCaves = meFixture({ caves: [OWNER_CAVE, VIEWER_CAVE], currentCaveId: OWNER_CAVE.id });

it('propose les caves avec « (lecture) » pour un membre, la courante choisie', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(twoCaves);
  mount();
  const select = await screen.findByRole('combobox', { name: 'Cave' });
  expect(select).toHaveValue('c1');
  const options = within(select).getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['Cave de Franck', 'Cave de Paul (lecture)']);
  expect(screen.queryByText('Lecture seule')).not.toBeInTheDocument();
});

it('change de cave, retire tout le cache de l’ancienne sauf la session et quitte une page réservée devenue interdite', async () => {
  const getMe = vi.spyOn(api, 'getMe').mockResolvedValue(twoCaves);
  const viewerSession = { ...twoCaves, currentCaveId: VIEWER_CAVE.id };
  // Comme l'api : après le changement, /auth/me répond la nouvelle cave courante.
  const set = vi.spyOn(api, 'setCurrentCave').mockImplementation(async () => {
    getMe.mockResolvedValue(viewerSession);
    return viewerSession;
  });
  const qc = mount({ title: 'Journal' }, '/journal');
  qc.setQueryData(['cave', {}], [{ id: 'w-ancienne' }]);
  qc.setQueryData(['admin', 'users'], []);
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Cave' }), 'c2');
  await waitFor(() => expect(set).toHaveBeenCalledWith('c2'));
  await waitFor(() => expect(qc.getQueryData(['cave', {}])).toBeUndefined());
  expect(qc.getQueryData(['admin', 'users'])).toBeUndefined();
  // Aucune relecture : elle afficherait l'ancien contenu le temps du chargement.
  expect(invalidate).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
  expect(qc.getQueryData(['me'])).toEqual(viewerSession);
  expect(await screen.findByText('Lecture seule')).toBeInTheDocument();
});

it('reste sur la liste de la cave après un changement de cave', async () => {
  const getMe = vi.spyOn(api, 'getMe').mockResolvedValue(twoCaves);
  const viewerSession = { ...twoCaves, currentCaveId: VIEWER_CAVE.id };
  vi.spyOn(api, 'setCurrentCave').mockImplementation(async () => {
    getMe.mockResolvedValue(viewerSession);
    return viewerSession;
  });
  mount({ title: 'Ma cave' }, '/cave');
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Cave' }), 'c2');
  expect(await screen.findByText('Lecture seule')).toBeInTheDocument();
  expect(screen.getByTestId('where')).toHaveTextContent('/cave');
});

it('affiche l’erreur de l’api si la cave n’est plus accessible', async () => {
  vi.spyOn(api, 'getMe').mockResolvedValue(twoCaves);
  vi.spyOn(api, 'setCurrentCave').mockRejectedValue(new api.ApiError(404, 'Cave introuvable'));
  mount();
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Cave' }), 'c2');
  expect(await screen.findByRole('alert')).toHaveTextContent('Cave introuvable');
});
