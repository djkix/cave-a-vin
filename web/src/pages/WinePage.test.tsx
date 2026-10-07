import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../lib/api-client';
import { meFixture, viewerMe } from '../test-fixtures';
import { WinePage } from './WinePage';

afterEach(() => vi.restoreAllMocks());

const detail: api.WineDetail = {
  wine: {
    id: 'w1', producer: 'Domaine Tempier', cuvee: 'La Tourtine', appellationRaw: 'Bandol', vintage: 2019, color: 'ROUGE', formatCl: 75, referencePhotoId: 'p1', quantity: 6,
    referencePhotoSource: null, referencePhotoSourceUrl: null,
    pairing: { status: 'DONE', dishes: [], errorMessage: null, generatedAt: null },
    producerKey: 'domaine tempier',
    producerProfile: {
      key: 'domaine tempier', displayName: 'Domaine Tempier', status: 'DONE', description: 'Un domaine du Var…',
      source: 'GEMINI', errorMessage: null, generatedAt: '2026-10-05T10:00:00Z', updatedBy: null,
    },
  },
  movements: [{ id: 'm1', delta: 6, type: 'IN', occurredAt: '2026-09-21T10:00:00Z', note: null, reversesId: null }],
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/cave/w1']}>
        <Routes>
          <Route path="/cave/:wineId" element={<WinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('affiche le vin, son stock et ses derniers mouvements', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  expect(await screen.findByRole('heading', { name: /Domaine Tempier/ })).toBeInTheDocument();
  expect(screen.getByText('6 en stock')).toBeInTheDocument();
  expect(screen.getByText('+6')).toBeInTheDocument();
});

it('annonce l’écart avant de corriger le stock', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const inventory = vi.spyOn(api, 'postInventory').mockResolvedValue({ movement: { id: 'a1' }, stock: 4, delta: -2, created: true });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
  await userEvent.type(screen.getByLabelText('Bouteilles comptées'), '4');
  expect(screen.getByText('−2 bouteilles')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’inventaire' }));
  await waitFor(() => expect(inventory).toHaveBeenCalledWith('w1', { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), counted: 4 }));
});

it('dit « stock déjà juste » et n’envoie rien quand le compte est identique', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const inventory = vi.spyOn(api, 'postInventory');
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  expect(screen.getByText('Stock déjà juste')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer l’inventaire' })).toBeDisabled();
  expect(inventory).not.toHaveBeenCalled();
});

it('refuse un compte négatif ou décimal', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
  await userEvent.type(screen.getByLabelText('Bouteilles comptées'), '2.5');
  expect(screen.getByRole('button', { name: 'Enregistrer l’inventaire' })).toBeDisabled();
});

it('refuse un compte au-delà de 100 000 bouteilles', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  const inventory = vi.spyOn(api, 'postInventory');
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger le stock' }));
  await userEvent.clear(screen.getByLabelText('Bouteilles comptées'));
  await userEvent.type(screen.getByLabelText('Bouteilles comptées'), '100001');
  expect(screen.getByText('Nombre de bouteilles trop élevé')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer l’inventaire' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’inventaire' }));
  expect(inventory).not.toHaveBeenCalled();
});

it('montre « Vin introuvable » pour un identifiant inconnu', async () => {
  vi.spyOn(api, 'getWine').mockRejectedValue(new api.ApiError(404, 'Vin introuvable'));
  mount();
  expect(await screen.findByText('Vin introuvable')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Retour à la cave' })).toHaveAttribute('href', '/cave');
});

it('garde le résultat de la sortie affiché après le rafraîchissement du stock', async () => {
  const getWine = vi.spyOn(api, 'getWine')
    .mockResolvedValueOnce(detail)
    .mockResolvedValue({ ...detail, wine: { ...detail.wine, quantity: 5 } });
  vi.spyOn(api, 'createOut').mockResolvedValue({
    movement: { id: 'm2', delta: -1, type: 'OUT', occurredAt: '' },
    wine: detail.wine,
    stock: 5,
    created: true,
  });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /Sortir 1 bouteille/ }));
  await screen.findByText('Sorti — il en reste 5');
  await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Sorti — il en reste 5')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Annuler la sortie' })).toBeInTheDocument();
});

it('garde le résultat affiché quand la sortie vide le stock', async () => {
  const last = { ...detail, wine: { ...detail.wine, quantity: 1 } };
  const getWine = vi.spyOn(api, 'getWine')
    .mockResolvedValueOnce(last)
    .mockResolvedValue({ ...last, wine: { ...last.wine, quantity: 0 } });
  vi.spyOn(api, 'createOut').mockResolvedValue({
    movement: { id: 'm3', delta: -1, type: 'OUT', occurredAt: '' },
    wine: last.wine,
    stock: 0,
    created: true,
  });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: /Sortir 1 bouteille/ }));
  await screen.findByText('Sorti — il en reste 0');
  await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Sorti — il en reste 0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Annuler la sortie' })).toBeInTheDocument();
});

it('ne propose pas de sortie pour un vin déjà épuisé', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue({ ...detail, wine: { ...detail.wine, quantity: 0 } });
  mount();
  await screen.findByRole('heading', { name: /Domaine Tempier/ });
  expect(screen.queryByRole('button', { name: /Sortir/ })).not.toBeInTheDocument();
});

it('montre le bloc « Le domaine » au-dessus des accords mets-vins', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue(detail);
  mount();
  const domaine = await screen.findByText('Un domaine du Var…');
  const accords = screen.getByText('Suggestions générées par Gemini');
  expect(domaine.compareDocumentPosition(accords) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('masque le bloc « Le domaine » quand le vin n’a pas de domaine identifiable', async () => {
  vi.spyOn(api, 'getWine').mockResolvedValue({ ...detail, wine: { ...detail.wine, producerKey: null, producerProfile: null } });
  mount();
  await screen.findByRole('heading', { name: /Domaine Tempier/ });
  expect(screen.queryByText('Le domaine')).not.toBeInTheDocument();
});

it('referme la correction d’apogée en cours quand on change de vin', async () => {
  const apogee: api.Apogee = { min: 2024, max: 2030, confidence: 'FAIBLE', status: 'A_BOIRE', reason: null, source: 'REGLE' };
  const detailWithApogee = { ...detail, wine: { ...detail.wine, apogee } };
  const detail2 = { ...detail, wine: { ...detail.wine, id: 'w2', producer: 'Domaine Tempier 2', apogee } };
  vi.spyOn(api, 'getWine').mockImplementation((id: string) => Promise.resolve(id === 'w2' ? detail2 : detailWithApogee));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Vin déjà visité auparavant : ses données sont déjà en cache, donc la fiche
  // ne repasse pas par l'état de chargement en changeant de vin — exactement
  // le cas où l'état du formulaire de correction pourrait survivre au bascule.
  qc.setQueryData(['wine', 'w2'], detail2);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/cave/w1']}>
        <Link to="/cave/w2">suivant</Link>
        <Routes>
          <Route path="/cave/:wineId" element={<WinePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Corriger' }));
  await userEvent.clear(screen.getByLabelText('Année de début'));
  await userEvent.type(screen.getByLabelText('Année de début'), '2099');
  expect(screen.getByLabelText('Année de début')).toHaveValue('2099');
  await userEvent.click(screen.getByRole('link', { name: 'suivant' }));
  await screen.findByRole('heading', { name: /Domaine Tempier 2/ });
  expect(screen.queryByLabelText('Année de début')).not.toBeInTheDocument();
});

describe('recherche d’image depuis la fiche', () => {
  const candidates: api.ImageCandidate[] = [
    { id: 'c1', source: 'Open Food Facts (CC BY-SA)', sourceUrl: 'https://world.openfoodfacts.org/product/1', imageUrl: '/api/image-candidates/c1' },
    { id: 'c2', source: 'domainetempier.com', sourceUrl: 'https://domainetempier.com/vin', imageUrl: '/api/image-candidates/c2' },
  ];

  it('affiche le chargement puis les images trouvées avec leur source', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    let resolveSearch!: (v: { candidates: api.ImageCandidate[] }) => void;
    vi.spyOn(api, 'searchWineImages').mockReturnValue(new Promise((r) => { resolveSearch = r; }));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    expect(screen.getByText('Recherche en cours…')).toBeInTheDocument();
    resolveSearch({ candidates });
    await screen.findAllByRole('button', { name: 'Choisir cette image' });
    expect(screen.getByRole('link', { name: 'Open Food Facts (CC BY-SA)' })).toHaveAttribute('href', candidates[0].sourceUrl);
    expect(screen.getByRole('link', { name: 'Open Food Facts (CC BY-SA)' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Open Food Facts (CC BY-SA)' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'domainetempier.com' })).toBeInTheDocument();
    const images = screen.getAllByRole('img').filter((img) => (img as HTMLImageElement).src.includes('/api/image-candidates/'));
    expect(images[0]).toHaveAttribute('src', candidates[0].imageUrl);
  });

  it('dit qu’aucune image n’a été trouvée', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'searchWineImages').mockResolvedValue({ candidates: [] });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    expect(await screen.findByText('Aucune image trouvée pour ce vin')).toBeInTheDocument();
  });

  it('affiche l’indisponibilité (503) en clair', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'searchWineImages').mockRejectedValue(new api.ApiError(503, 'Service indisponible'));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    expect(await screen.findByText('Recherche d’image indisponible pour le moment')).toBeInTheDocument();
  });

  it('signale la limite de recherches (429)', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'searchWineImages').mockRejectedValue(new api.ApiError(429, 'ThrottlerException: Too Many Requests'));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    expect(await screen.findByText('Trop de recherches, réessayez dans une minute')).toBeInTheDocument();
  });

  it('ferme la fenêtre de choix', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'searchWineImages').mockResolvedValue({ candidates: [] });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    await screen.findByText('Aucune image trouvée pour ce vin');
    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByText('Aucune image trouvée pour ce vin')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chercher une image' })).toBeInTheDocument();
  });

  it('choisit une image puis rafraîchit la fiche', async () => {
    const withSource = { ...detail, wine: { ...detail.wine, referencePhotoSource: 'Open Food Facts (CC BY-SA)', referencePhotoSourceUrl: 'https://world.openfoodfacts.org/product/1' } };
    const getWine = vi.spyOn(api, 'getWine').mockResolvedValueOnce(detail).mockResolvedValue(withSource);
    vi.spyOn(api, 'searchWineImages').mockResolvedValue({ candidates });
    const choose = vi.spyOn(api, 'chooseReferenceImage').mockResolvedValue({
      referencePhotoId: 'c1', referencePhotoSource: 'Open Food Facts (CC BY-SA)', referencePhotoSourceUrl: 'https://world.openfoodfacts.org/product/1',
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    const chooseButtons = await screen.findAllByRole('button', { name: 'Choisir cette image' });
    await userEvent.click(chooseButtons[0]);
    await waitFor(() => expect(choose).toHaveBeenCalledWith('w1', 'c1'));
    await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Image :')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Food Facts (CC BY-SA)' })).toHaveAttribute('href', 'https://world.openfoodfacts.org/product/1');
    expect(screen.queryByRole('button', { name: 'Choisir cette image' })).not.toBeInTheDocument();
  });

  it('refuse une proposition expirée (410) en clair', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'searchWineImages').mockResolvedValue({ candidates });
    vi.spyOn(api, 'chooseReferenceImage').mockRejectedValue(new api.ApiError(410, 'Proposition expirée, relancez la recherche'));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    const chooseButtons = await screen.findAllByRole('button', { name: 'Choisir cette image' });
    await userEvent.click(chooseButtons[0]);
    expect(await screen.findByText('Proposition expirée, relancez la recherche')).toBeInTheDocument();
  });

  it('502 et 504 (passerelle, délai) valent aussi « indisponible pour le moment »', async () => {
    for (const status of [502, 504]) {
      // La session par défaut est restaurée à la fin de chaque tour : on la remet.
      vi.spyOn(api, 'getMe').mockResolvedValue(meFixture());
      vi.spyOn(api, 'getWine').mockResolvedValue(detail);
      vi.spyOn(api, 'searchWineImages').mockRejectedValue(new api.ApiError(status, 'Bad Gateway'));
      const { unmount } = mount();
      await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
      expect(await screen.findByText('Recherche d’image indisponible pour le moment')).toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
    }
  });

  it('garde les images proposées quand le choix échoue pour une autre raison que l’expiration', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'searchWineImages').mockResolvedValue({ candidates });
    vi.spyOn(api, 'chooseReferenceImage').mockRejectedValue(new api.ApiError(500, 'Enregistrement impossible'));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    const chooseButtons = await screen.findAllByRole('button', { name: 'Choisir cette image' });
    await userEvent.click(chooseButtons[1]);
    expect(await screen.findByText('Enregistrement impossible')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Choisir cette image' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Choisir cette image' })[0]).toBeEnabled();
    expect(screen.getByRole('link', { name: 'domainetempier.com' })).toBeInTheDocument();
  });

  it('ouvre la fenêtre de choix sous l’en-tête de la fiche, sur toute sa largeur, pas dans la colonne de la vignette', async () => {
    vi.spyOn(api, 'getWine').mockResolvedValue(detail);
    vi.spyOn(api, 'searchWineImages').mockResolvedValue({ candidates });
    const { container } = mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Chercher une image' }));
    const window = await screen.findByRole('region', { name: 'Images proposées' });
    const header = container.querySelector('.wine-head__row')!;
    expect(header).not.toBeNull();
    // L'en-tête (vignette + titre) ne contient ni la fenêtre ni ses images.
    expect(header).toContainElement(screen.getByRole('heading', { name: /Domaine Tempier/ }));
    expect(header).not.toContainElement(window);
    // La fenêtre est dans la même carte que l'en-tête, après lui.
    expect(header.parentElement).toContainElement(window);
    expect(header.compareDocumentPosition(window) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Grille d'images ; chaque proposition : image, lien vers la source, bouton.
    expect(window.querySelector('ul')).toHaveClass('image-search__grid');
    for (const link of [screen.getByRole('link', { name: 'Open Food Facts (CC BY-SA)' }), screen.getByRole('link', { name: 'domainetempier.com' })]) {
      expect(link).toHaveClass('link');
    }
  });

  it('la ligne « Image : … / Revenir à ma photo » est sous l’en-tête, et son lien a le style de l’application', async () => {
    const withSource = { ...detail, wine: { ...detail.wine, referencePhotoSource: 'domainetempier.com', referencePhotoSourceUrl: 'https://domainetempier.com/vin' } };
    vi.spyOn(api, 'getWine').mockResolvedValue(withSource);
    const { container } = mount();
    const link = await screen.findByRole('link', { name: 'domainetempier.com' });
    const header = container.querySelector('.wine-head__row')!;
    expect(link).toHaveClass('link');
    expect(header).not.toContainElement(link);
    expect(header).not.toContainElement(screen.getByRole('button', { name: 'Revenir à ma photo' }));
  });

  it('revient à la photo d’origine', async () => {
    const withSource = { ...detail, wine: { ...detail.wine, referencePhotoSource: 'domainetempier.com', referencePhotoSourceUrl: 'https://domainetempier.com/vin' } };
    const getWine = vi.spyOn(api, 'getWine').mockResolvedValueOnce(withSource).mockResolvedValue(detail);
    const revert = vi.spyOn(api, 'revertReferenceImage').mockResolvedValue({ referencePhotoId: 'p1', referencePhotoSource: null, referencePhotoSourceUrl: null });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Revenir à ma photo' }));
    await waitFor(() => expect(revert).toHaveBeenCalledWith('w1'));
    await waitFor(() => expect(getWine).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Revenir à ma photo' })).not.toBeInTheDocument();
  });
});

describe('selon le rôle', () => {
  const apogee: api.Apogee = { min: 2024, max: 2030, confidence: 'SAISIE', status: 'A_BOIRE', reason: null, source: 'MANUEL' };
  const full: api.WineDetail = {
    ...detail,
    wine: {
      ...detail.wine, apogee,
      rating: { value: 16.5, ratedAt: '2026-09-01T10:00:00Z', ratedBy: null },
      referencePhotoSource: 'domainetempier.com', referencePhotoSourceUrl: 'https://domainetempier.com/vin',
    },
  };

  it('ne montre aucun bouton d’action à un membre en lecture seule, mais tout le contenu', async () => {
    const me = vi.spyOn(api, 'getMe').mockResolvedValue(viewerMe());
    vi.spyOn(api, 'getWine').mockResolvedValue(full);
    mount();
    expect(await screen.findByRole('heading', { name: /Domaine Tempier/ })).toBeInTheDocument();
    await waitFor(() => expect(me).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('6 en stock')).toBeInTheDocument();
    expect(screen.getByText('Un domaine du Var…')).toBeInTheDocument();
    expect(screen.getByText('Accords mets-vins')).toBeInTheDocument();
    expect(screen.getByText('Apogée')).toBeInTheDocument();
    expect(screen.getByText(/notée le/)).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const name of ['Noter ce vin', 'Modifier', 'Retirer', 'Corriger', 'Régénérer', 'Chercher une image', 'Revenir à ma photo', 'Corriger le stock', /Sortir/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('montre au propriétaire non administrateur toutes les actions sauf celles du domaine', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ isAdmin: false }));
    vi.spyOn(api, 'getWine').mockResolvedValue(full);
    mount();
    expect(await screen.findByRole('button', { name: 'Corriger le stock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Corriger' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revenir à ma photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sortir/ })).toBeInTheDocument();
    const domaine = within(screen.getByRole('heading', { name: 'Le domaine' }).closest('section')!);
    expect(domaine.queryByRole('button')).not.toBeInTheDocument();
  });

  it('montre les actions du domaine à un administrateur', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(meFixture({ isAdmin: true }));
    vi.spyOn(api, 'getWine').mockResolvedValue(full);
    mount();
    const heading = await screen.findByRole('heading', { name: 'Le domaine' });
    const domaine = within(heading.closest('section')!);
    expect(await domaine.findByRole('button', { name: 'Modifier' })).toBeInTheDocument();
    expect(domaine.getByRole('button', { name: 'Régénérer' })).toBeInTheDocument();
  });
});
