import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../lib/api-client';
import { MaCavePage } from './MaCavePage';

afterEach(() => vi.restoreAllMocks());

const zones: api.Zone[] = [
  { id: 'z1', name: 'Cave 1', indication: 'À gauche en entrant', hasPhoto: true, sortOrder: 0, marker: null },
  { id: 'z2', name: 'Garage', indication: null, hasPhoto: false, sortOrder: 1, marker: null },
  { id: 'z3', name: 'Cellier', indication: 'Au fond, derrière l’escalier', hasPhoto: false, sortOrder: 2, marker: null },
];

// Zones lues par défaut (vide) : les tests des membres et du nom n'en dépendent pas.
beforeEach(() => {
  vi.spyOn(api, 'getZones').mockResolvedValue([]);
  vi.spyOn(api, 'getPlan').mockResolvedValue({ plan: null, markers: [] });
});

const members: api.MemberView[] = [
  { id: 'm1', email: 'franck@example.com', displayName: 'Franck', role: 'OWNER', pending: false },
  { id: 'm2', email: 'paul@example.com', displayName: 'Paul', role: 'VIEWER', pending: false },
  { id: 'm3', email: 'lea@example.com', displayName: null, role: 'VIEWER', pending: true },
];

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/ma-cave']}>
        <MaCavePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const rowOf = (email: string) => screen.getByText(email).closest<HTMLElement>('.list__row')!;
const zonesCard = () => within(screen.getByRole('region', { name: 'Zones' }));
const zoneRow = (name: string) => within(zonesCard().getByRole('listitem', { name }));

it('regroupe le nom de la cave, le plan, les zones puis les membres, sous le titre « Ma cave »', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  mount();
  expect(screen.getByRole('heading', { level: 1, name: 'Ma cave' })).toBeInTheDocument();
  await screen.findByText('franck@example.com');
  const order = [screen.getByLabelText('Nom de la cave'), screen.getByRole('region', { name: 'Plan de la cave' }), screen.getByRole('region', { name: 'Zones' }), screen.getByRole('region', { name: 'Membres' })];
  for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

describe('zones', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
  });

  it('liste les zones dans leur ordre, avec indication et vignette', async () => {
    vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    mount();
    await zonesCard().findByText('Cave 1');
    expect(zonesCard().getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['Cave 1', 'Garage', 'Cellier']);
    expect(zoneRow('Cave 1').getByText('À gauche en entrant')).toBeInTheDocument();
    expect(zoneRow('Cave 1').getByRole('img', { name: 'Photo de la zone Cave 1' })).toHaveAttribute('src', '/api/caves/zones/z1/photo');
    expect(zoneRow('Garage').queryByRole('img')).not.toBeInTheDocument();
    expect(zoneRow('Cave 1').getByRole('button', { name: 'Retirer la photo' })).toBeInTheDocument();
    expect(zoneRow('Garage').queryByRole('button', { name: 'Retirer la photo' })).not.toBeInTheDocument();
    // Libellé visible, nom de la zone compris, sans aria-label qui le remplacerait.
    expect(zoneRow('Cave 1').getByLabelText('Changer la photo de Cave 1')).toBeInTheDocument();
    const input = zoneRow('Garage').getByLabelText('Ajouter une photo de Garage');
    expect(input).not.toHaveAttribute('aria-label');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).toHaveAttribute('capture', 'environment');
  });

  it('sans zone : le dit, et propose d’en ajouter une', async () => {
    mount();
    expect(await zonesCard().findByText(/Aucune zone pour l’instant/)).toBeInTheDocument();
    expect(zonesCard().getByRole('button', { name: 'Ajouter une zone' })).toBeInTheDocument();
  });

  it('ajoute une zone (nom et indication) puis relit la liste', async () => {
    const list = vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    const create = vi.spyOn(api, 'createZone').mockResolvedValue({ id: 'z4', name: 'Placard', indication: null, hasPhoto: false, sortOrder: 3, marker: null });
    mount();
    await zonesCard().findByText('Cave 1');
    await userEvent.type(zonesCard().getByLabelText('Nom de la nouvelle zone'), '  Placard ');
    await userEvent.type(zonesCard().getByLabelText('Indication de la nouvelle zone'), 'Dans l’entrée');
    await userEvent.click(zonesCard().getByRole('button', { name: 'Ajouter une zone' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Placard', indication: 'Dans l’entrée' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(zonesCard().getByLabelText('Nom de la nouvelle zone')).toHaveValue('');
  });

  it('affiche tel quel le refus de l’api (nom déjà pris)', async () => {
    vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    vi.spyOn(api, 'createZone').mockRejectedValue(new api.ApiError(409, 'Une zone porte déjà ce nom'));
    mount();
    await zonesCard().findByText('Cave 1');
    await userEvent.type(zonesCard().getByLabelText('Nom de la nouvelle zone'), 'garage');
    await userEvent.click(zonesCard().getByRole('button', { name: 'Ajouter une zone' }));
    expect(await zonesCard().findByRole('alert')).toHaveTextContent('Une zone porte déjà ce nom');
  });

  it('↑ et ↓ échangent une zone avec sa voisine ; pas de ↑ en tête ni de ↓ en fin', async () => {
    vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    const reorder = vi.spyOn(api, 'reorderZones').mockResolvedValue(zones);
    mount();
    await zonesCard().findByText('Cave 1');
    expect(zoneRow('Cave 1').getByRole('button', { name: 'Monter Cave 1' })).toBeDisabled();
    expect(zoneRow('Cellier').getByRole('button', { name: 'Descendre Cellier' })).toBeDisabled();
    await userEvent.click(zoneRow('Garage').getByRole('button', { name: 'Descendre Garage' }));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['z1', 'z3', 'z2']));
    await userEvent.click(zoneRow('Garage').getByRole('button', { name: 'Monter Garage' }));
    await waitFor(() => expect(reorder).toHaveBeenLastCalledWith(['z2', 'z1', 'z3']));
  });

  it('« Modifier » ouvre un formulaire prérempli dans la ligne et enregistre nom et indication', async () => {
    vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    const update = vi.spyOn(api, 'updateZone').mockResolvedValue({ ...zones[2], name: 'Cellier du bas', indication: null });
    mount();
    await zonesCard().findByText('Cellier');
    await userEvent.click(zoneRow('Cellier').getByRole('button', { name: 'Modifier' }));
    const name = zoneRow('Cellier').getByLabelText('Nom');
    expect(name).toHaveValue('Cellier');
    expect(zoneRow('Cellier').getByLabelText('Indication')).toHaveValue('Au fond, derrière l’escalier');
    await userEvent.clear(name);
    await userEvent.type(name, 'Cellier du bas');
    await userEvent.clear(zoneRow('Cellier').getByLabelText('Indication'));
    await userEvent.click(zoneRow('Cellier').getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('z3', { name: 'Cellier du bas', indication: null }));
  });

  it('« Supprimer » demande confirmation et affiche tel quel le 409 des bouteilles encore rangées', async () => {
    vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    const remove = vi.spyOn(api, 'deleteZone').mockRejectedValue(new api.ApiError(409, 'Des bouteilles sont encore rangées dans cette zone'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount();
    await zonesCard().findByText('Garage');
    await userEvent.click(zoneRow('Garage').getByRole('button', { name: 'Supprimer' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Garage'));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(zoneRow('Garage').getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('z2'));
    expect(await zonesCard().findByRole('alert')).toHaveTextContent('Des bouteilles sont encore rangées dans cette zone');
  });

  it.each([
    [false, 'Zone supprimée'],
    [true, 'Zone archivée (elle reste dans l’historique)'],
  ])('après « Supprimer » (archived: %s) : « %s »', async (archived, message) => {
    vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    const remove = vi.spyOn(api, 'deleteZone').mockResolvedValue({ archived });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    await zonesCard().findByText('Garage');
    await userEvent.click(zoneRow('Garage').getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('z2'));
    expect(await zonesCard().findByRole('status')).toHaveTextContent(message);
  });

  it('envoie la photo choisie et retire la photo', async () => {
    const list = vi.spyOn(api, 'getZones').mockResolvedValue(zones);
    const upload = vi.spyOn(api, 'uploadZonePhoto').mockResolvedValue({ ...zones[1], hasPhoto: true });
    const removePhoto = vi.spyOn(api, 'removeZonePhoto').mockResolvedValue({ ...zones[0], hasPhoto: false });
    mount();
    await zonesCard().findByText('Garage');
    const file = new File(['jpeg'], 'garage.jpg', { type: 'image/jpeg' });
    await userEvent.upload(zoneRow('Garage').getByLabelText('Ajouter une photo de Garage'), file);
    await waitFor(() => expect(upload).toHaveBeenCalledWith('z2', expect.any(Blob)));
    await userEvent.click(zoneRow('Cave 1').getByRole('button', { name: 'Retirer la photo' }));
    await waitFor(() => expect(removePhoto).toHaveBeenCalledWith('z1'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });
});


it('liste les membres avec leur rôle, l’invitation en attente et « Retirer » hors propriétaire', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  mount();
  expect(await screen.findByText('franck@example.com')).toBeInTheDocument();
  const owner = within(rowOf('franck@example.com'));
  expect(owner.getByText('Franck')).toBeInTheDocument();
  expect(owner.getByText('Propriétaire')).toBeInTheDocument();
  expect(owner.queryByRole('button', { name: /Retirer/ })).not.toBeInTheDocument();
  const paul = within(rowOf('paul@example.com'));
  expect(paul.getByText('Paul')).toBeInTheDocument();
  expect(paul.getByText('Lecture seule')).toBeInTheDocument();
  expect(paul.getByRole('button', { name: /Retirer/ })).toBeInTheDocument();
  const lea = within(rowOf('lea@example.com'));
  expect(lea.getByText('Invitation en attente')).toBeInTheDocument();
  expect(lea.queryByText(/null/)).not.toBeInTheDocument();
  expect(lea.getByRole('button', { name: /Retirer/ })).toBeInTheDocument();
});

it('invite une adresse puis recharge la liste', async () => {
  const list = vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  const invite = vi.spyOn(api, 'inviteMember').mockResolvedValue({ id: 'm4', email: 'zoe@example.com', displayName: null, role: 'VIEWER', pending: true });
  mount();
  await screen.findByText('paul@example.com');
  await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'zoe@example.com');
  await userEvent.click(screen.getByRole('button', { name: 'Inviter' }));
  await waitFor(() => expect(invite).toHaveBeenCalledWith('zoe@example.com'));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Adresse e-mail')).toHaveValue('');
});

it('affiche tel quel le refus de l’api pour une adresse déjà membre', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  vi.spyOn(api, 'inviteMember').mockRejectedValue(new api.ApiError(409, 'Cette adresse est déjà membre'));
  mount();
  await screen.findByText('paul@example.com');
  await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'paul@example.com');
  await userEvent.click(screen.getByRole('button', { name: 'Inviter' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Cette adresse est déjà membre');
});

it('retire un membre après confirmation, et rien sans confirmation', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  const remove = vi.spyOn(api, 'removeMember').mockResolvedValue(undefined);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  mount();
  await screen.findByText('paul@example.com');
  const button = within(rowOf('paul@example.com')).getByRole('button', { name: /Retirer/ });
  await userEvent.click(button);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('paul@example.com'));
  expect(remove).not.toHaveBeenCalled();
  await userEvent.click(button);
  await waitFor(() => expect(remove).toHaveBeenCalledWith('m2'));
});

it('affiche l’erreur de l’api au retrait', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  vi.spyOn(api, 'removeMember').mockRejectedValue(new api.ApiError(404, 'Membre introuvable'));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  mount();
  await screen.findByText('paul@example.com');
  await userEvent.click(within(rowOf('paul@example.com')).getByRole('button', { name: /Retirer/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Membre introuvable');
});

it('renomme la cave, nom prérempli, et rafraîchit la session', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  const rename = vi.spyOn(api, 'renameCave').mockResolvedValue({ id: 'c1', name: 'Cave du Var' });
  const qc = mount();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const input = screen.getByLabelText('Nom de la cave');
  await waitFor(() => expect(input).toHaveValue('Cave de Franck'));
  await userEvent.clear(input);
  await userEvent.type(input, '  Cave du Var ');
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(rename).toHaveBeenCalledWith('Cave du Var'));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] }));
});

it('refuse un nom vide ou de plus de 80 caractères, sans appel', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  const rename = vi.spyOn(api, 'renameCave');
  mount();
  const input = screen.getByLabelText('Nom de la cave');
  await waitFor(() => expect(input).toHaveValue('Cave de Franck'));
  await userEvent.clear(input);
  await userEvent.type(input, '   ');
  expect(screen.getByText('Le nom de la cave doit faire de 1 à 80 caractères')).toBeInTheDocument();
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription('Le nom de la cave doit faire de 1 à 80 caractères');
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await userEvent.clear(input);
  await userEvent.type(input, 'x'.repeat(81));
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await userEvent.clear(input);
  await userEvent.type(input, 'x'.repeat(80));
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
  expect(screen.queryByText('Le nom de la cave doit faire de 1 à 80 caractères')).not.toBeInTheDocument();
  expect(input).toHaveAttribute('aria-invalid', 'false');
  expect(rename).not.toHaveBeenCalled();
});

it('affiche le refus de l’api au renommage', async () => {
  vi.spyOn(api, 'getMembers').mockResolvedValue(members);
  vi.spyOn(api, 'renameCave').mockRejectedValue(new api.ApiError(400, 'Le nom de la cave doit faire de 1 à 80 caractères'));
  mount();
  const input = screen.getByLabelText('Nom de la cave');
  await waitFor(() => expect(input).toHaveValue('Cave de Franck'));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Le nom de la cave doit faire de 1 à 80 caractères');
});

describe('plan de la cave', () => {
  const plan = { width: 2000, height: 1000, updatedAt: '2026-10-13T10:00:00.000Z' };
  const placed: api.Zone[] = [{ ...zones[0], marker: { x: 0.1, y: 0.2 } }, zones[1], zones[2]];
  const withPlan = { plan, markers: [{ zoneId: 'z1', name: 'Cave 1', number: 1, x: 0.1, y: 0.2 }] };
  const planCard = () => within(screen.getByRole('region', { name: 'Plan de la cave' }));
  /** Toucher le plan à (x, y) en fractions : boîte rendue simulée de 400 × 200 px. */
  async function tapPlan(x: number, y: number) {
    const box = (await planCard().findByRole('img', { name: 'Plan de la cave' })).parentElement!;
    box.getBoundingClientRect = () => ({ left: 10, top: 50, width: 400, height: 200, right: 410, bottom: 250, x: 10, y: 50, toJSON: () => ({}) });
    fireEvent.click(box, { clientX: 10 + x * 400, clientY: 50 + y * 200 });
  }

  beforeEach(() => {
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
  });

  it('sans plan : l’explique et propose d’en ajouter un (photo), sans « Retirer le plan »', async () => {
    mount();
    expect(await planCard().findByText('Photographiez la pièce ou un schéma dessiné à la main, puis placez vos zones dessus.')).toBeInTheDocument();
    const input = planCard().getByLabelText('Ajouter le plan de la cave');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).toHaveAttribute('capture', 'environment');
    expect(planCard().queryByRole('button', { name: 'Retirer le plan' })).not.toBeInTheDocument();
  });

  it('envoie le plan choisi puis le relit ; l’image montre les repères', async () => {
    const get = vi.spyOn(api, 'getPlan').mockResolvedValueOnce({ plan: null, markers: [] }).mockResolvedValue(withPlan);
    vi.spyOn(api, 'getZones').mockResolvedValue(placed);
    const upload = vi.spyOn(api, 'uploadPlan').mockResolvedValue(plan);
    mount();
    const file = new File(['x'], 'plan.jpg', { type: 'image/jpeg' });
    await userEvent.upload(await planCard().findByLabelText('Ajouter le plan de la cave'), file);
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await planCard().findByRole('img', { name: 'Plan de la cave' })).toHaveAttribute('src', '/api/caves/plans/c1/image?v=2026-10-13T10%3A00%3A00.000Z');
    expect(planCard().getByRole('button', { name: 'Zone 1 : Cave 1' })).toBeInTheDocument();
    expect(planCard().getByLabelText('Remplacer le plan')).toBeInTheDocument();
  });

  it('plan sans zone : « Créez d’abord des zones »', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue({ plan, markers: [] });
    mount();
    expect(await planCard().findByText("Créez d'abord des zones")).toBeInTheDocument();
  });

  it('toucher le plan pose un repère numéroté, puis on choisit parmi les zones sans repère', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(withPlan);
    vi.spyOn(api, 'getZones').mockResolvedValue(placed);
    const set = vi.spyOn(api, 'setZoneMarker').mockResolvedValue({ ...zones[2], marker: { x: 0.5, y: 0.25 } });
    mount();
    await planCard().findByRole('button', { name: 'Zone 1 : Cave 1' });
    await tapPlan(0.5, 0.25);
    expect(planCard().getByRole('img', { name: 'Nouveau repère' })).toHaveTextContent('+');
    const chooser = within(planCard().getByRole('group', { name: 'Quelle zone est ici ?' }));
    expect(chooser.getAllByRole('button').map((b) => b.textContent)).toEqual(['Garage', 'Cellier', 'Cave 1 (déplacer)', 'Annuler']);
    await userEvent.click(chooser.getByRole('button', { name: 'Cellier' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('z3', 0.5, 0.25));
    await waitFor(() => expect(planCard().queryByRole('group', { name: 'Quelle zone est ici ?' })).not.toBeInTheDocument());
  });

  it('toucher un repère montre sa zone ; « Déplacer » puis un toucher le déplace ; « Retirer le repère »', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(withPlan);
    vi.spyOn(api, 'getZones').mockResolvedValue(placed);
    const set = vi.spyOn(api, 'setZoneMarker').mockResolvedValue(placed[0]);
    const remove = vi.spyOn(api, 'removeZoneMarker').mockResolvedValue(zones[0]);
    mount();
    await userEvent.click(await planCard().findByRole('button', { name: 'Zone 1 : Cave 1' }));
    expect(planCard().getByText('À gauche en entrant')).toBeInTheDocument();
    await userEvent.click(planCard().getByRole('button', { name: 'Déplacer' }));
    expect(planCard().getByText('Touchez le nouvel endroit de Cave 1 sur le plan.')).toBeInTheDocument();
    // Pendant le déplacement, les repères ne captent pas le toucher : on peut poser tout près d'un autre.
    expect(planCard().queryByRole('button', { name: /^Zone \d/ })).not.toBeInTheDocument();
    await tapPlan(0.75, 0.5);
    await waitFor(() => expect(set).toHaveBeenCalledWith('z1', 0.75, 0.5));
    await userEvent.click(await planCard().findByRole('button', { name: 'Zone 1 : Cave 1' }));
    await userEvent.click(planCard().getByRole('button', { name: 'Retirer le repère' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('z1'));
  });

  it('affiche tel quel le refus de l’api', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(withPlan);
    vi.spyOn(api, 'getZones').mockResolvedValue(placed);
    vi.spyOn(api, 'setZoneMarker').mockRejectedValue(new api.ApiError(409, "Ajoutez d'abord un plan de la cave"));
    mount();
    await planCard().findByRole('button', { name: 'Zone 1 : Cave 1' });
    await tapPlan(0.3, 0.3);
    await userEvent.click(planCard().getByRole('button', { name: 'Garage' }));
    expect(await planCard().findByRole('alert')).toHaveTextContent("Ajoutez d'abord un plan de la cave");
  });

  it('« Retirer le plan » demande confirmation et dit que les repères sont gardés', async () => {
    vi.spyOn(api, 'getPlan').mockResolvedValue(withPlan);
    vi.spyOn(api, 'getZones').mockResolvedValue(placed);
    const remove = vi.spyOn(api, 'removePlan').mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount();
    await userEvent.click(await planCard().findByRole('button', { name: 'Retirer le plan' }));
    expect(confirm).toHaveBeenLastCalledWith('Retirer le plan de la cave ? Les repères des zones sont gardés.');
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(planCard().getByRole('button', { name: 'Retirer le plan' }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(await planCard().findByRole('status')).toHaveTextContent('Plan retiré. Les repères des zones sont gardés.');
  });

  it('archiver une zone placée ou changer l’ordre relit le plan : repère disparu, numéros échangés', async () => {
    const two = { plan, markers: [{ zoneId: 'z1', name: 'Cave 1', number: 1, x: 0.1, y: 0.2 }, { zoneId: 'z3', name: 'Cellier', number: 2, x: 0.8, y: 0.8 }] };
    const swapped = { plan, markers: [{ zoneId: 'z3', name: 'Cellier', number: 1, x: 0.8, y: 0.8 }, { zoneId: 'z1', name: 'Cave 1', number: 2, x: 0.1, y: 0.2 }] };
    const archived = { plan, markers: [{ zoneId: 'z1', name: 'Cave 1', number: 1, x: 0.1, y: 0.2 }] };
    const getPlan = vi.spyOn(api, 'getPlan').mockResolvedValueOnce(two).mockResolvedValueOnce(swapped).mockResolvedValue(archived);
    const both: api.Zone[] = [placed[0], zones[1], { ...zones[2], marker: { x: 0.8, y: 0.8 } }];
    vi.spyOn(api, 'getZones').mockResolvedValue(both);
    vi.spyOn(api, 'reorderZones').mockResolvedValue(both);
    vi.spyOn(api, 'deleteZone').mockResolvedValue({ archived: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    expect(await planCard().findByRole('button', { name: 'Zone 2 : Cellier' })).toBeInTheDocument();
    await userEvent.click(zoneRow('Cellier').getByRole('button', { name: 'Monter Cellier' }));
    expect(await planCard().findByRole('button', { name: 'Zone 1 : Cellier' })).toBeInTheDocument();
    expect(planCard().getByRole('button', { name: 'Zone 2 : Cave 1' })).toBeInTheDocument();
    await userEvent.click(zoneRow('Cellier').getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(planCard().queryByRole('button', { name: /Cellier/ })).not.toBeInTheDocument());
    expect(planCard().getByRole('button', { name: 'Zone 1 : Cave 1' })).toBeInTheDocument();
    expect(getPlan).toHaveBeenCalledTimes(3);
  });
});
