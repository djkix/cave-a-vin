import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, FormEvent, useId, useState } from 'react';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { ZoneDetails } from '../components/LocationFields';
import { TopBar } from '../components/TopBar';
import {
  createZone, deleteZone, getMembers, inviteMember, MemberView, removeMember, removeZonePhoto, renameCave, reorderZones, updateZone, uploadZonePhoto, Zone,
} from '../lib/api-client';
import { useZones } from '../lib/locations';
import { shrinkPhoto } from '../lib/shrink-photo';
import { useCurrentCave } from '../lib/use-current-cave';

const NAME_MAX = 80;
const NAME_ERROR = 'Le nom de la cave doit faire de 1 à 80 caractères';

function RenameCard() {
  const qc = useQueryClient();
  const { cave } = useCurrentCave();
  // Brouillon : nul tant que l'utilisateur n'a rien tapé, le nom courant est alors affiché.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? cave?.name ?? '';
  const trimmed = value.trim();
  const invalid = trimmed.length === 0 || trimmed.length > NAME_MAX;
  const rename = useMutation({
    mutationFn: (name: string) => renameCave(name),
    onSuccess: () => {
      setDraft(null);
      // Le nom vient de la session (sélecteur de cave, ce formulaire) : on la relit.
      return qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!invalid) rename.mutate(trimmed);
  }

  return (
    <form className="card" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <label className="field__label" htmlFor="cave-name">Nom de la cave</label>
      <input
        id="cave-name"
        value={value}
        maxLength={200}
        aria-invalid={Boolean(cave) && invalid}
        aria-describedby={cave && invalid ? 'cave-name-error' : undefined}
        onChange={(e) => { setDraft(e.target.value); rename.reset(); }}
      />
      {cave && invalid && <p id="cave-name-error" className="text-error" style={{ margin: 0 }}>{NAME_ERROR}</p>}
      {rename.isError && <p role="alert" className="text-error" style={{ margin: 0 }}>{(rename.error as Error).message}</p>}
      {rename.isSuccess && <p role="status" className="list__meta" style={{ margin: 0 }}>Nom enregistré</p>}
      <button type="submit" className="btn btn--dark" disabled={!cave || invalid || rename.isPending}>Enregistrer</button>
    </form>
  );
}

function MemberRow({ member, busy, onRemove }: { member: MemberView; busy: boolean; onRemove: (m: MemberView) => void }) {
  const owner = member.role === 'OWNER';
  return (
    <div className="list__row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="list__title" style={{ margin: 0, overflowWrap: 'anywhere' }}>{member.email}</p>
        {member.displayName && <span className="list__meta">{member.displayName}</span>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)', marginTop: 'var(--space-xs)' }}>
          <span className={`badge ${owner ? 'badge--ok' : 'badge--warn'}`}>{owner ? 'Propriétaire' : 'Lecture seule'}</span>
          {member.pending && <span className="badge badge--warn">Invitation en attente</span>}
        </div>
      </div>
      {!owner && (
        <Button variant="link" aria-label={`Retirer ${member.email}`} disabled={busy} onClick={() => onRemove(member)}>
          Retirer
        </Button>
      )}
    </div>
  );
}

const ZONE_NAME_MAX = 40;
const INDICATION_MAX = 300;

/** Nom et indication d'une zone : ceux de l'ajout et de « Modifier ». */
function ZoneForm({ label, initial, submitLabel, busy, onSubmit, onCancel, idPrefix }: {
  label: string; initial: { name: string; indication: string }; submitLabel: string; busy: boolean;
  onSubmit: (v: { name: string; indication: string | null }) => void; onCancel?: () => void; idPrefix: string;
}) {
  const [name, setName] = useState(initial.name);
  const [indication, setIndication] = useState(initial.indication);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) onSubmit({ name: name.trim(), indication: indication.trim() || null });
  }
  return (
    <form aria-label={label} onSubmit={submit} className="zone-form">
      <label className="field__label" htmlFor={`${idPrefix}-name`}>{onCancel ? 'Nom' : 'Nom de la nouvelle zone'}</label>
      <input id={`${idPrefix}-name`} value={name} maxLength={ZONE_NAME_MAX} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      <label className="field__label" htmlFor={`${idPrefix}-indication`}>{onCancel ? 'Indication' : 'Indication de la nouvelle zone'}</label>
      <textarea id={`${idPrefix}-indication`} value={indication} maxLength={INDICATION_MAX} rows={2}
        placeholder="à gauche en entrant, au fond derrière l’escalier" onChange={(e) => setIndication(e.target.value)} />
      <button type="submit" className={onCancel ? 'btn btn--dark' : 'btn btn--primary'} disabled={!name.trim() || busy}>{submitLabel}</button>
      {onCancel && <Button variant="link" onClick={onCancel}>Annuler</Button>}
    </form>
  );
}

function ZoneRow({ zone, index, count, busy, photoVersion, onMove, onAction, onPhotoChanged }: {
  zone: Zone; index: number; count: number; busy: boolean; photoVersion?: number;
  onMove: (delta: -1 | 1) => void; onPhotoChanged: () => void;
  onAction: (run: () => Promise<unknown>, after?: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const id = useId();
  function confirmDelete() {
    if (window.confirm(`Supprimer la zone ${zone.name} ?`)) onAction(() => deleteZone(zone.id));
  }
  async function pickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onAction(async () => uploadZonePhoto(zone.id, await shrinkPhoto(file)), onPhotoChanged);
  }
  return (
    <li aria-label={zone.name} className="zone-row">
      <div className="zone-row__head">
        <p className="list__title" style={{ margin: 0, overflowWrap: 'anywhere', flex: 1, minWidth: 0 }}>{zone.name}</p>
        <button type="button" className="btn btn--outline zone-row__arrow" aria-label={`Monter ${zone.name}`} disabled={busy || index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="btn btn--outline zone-row__arrow" aria-label={`Descendre ${zone.name}`} disabled={busy || index === count - 1} onClick={() => onMove(1)}>↓</button>
      </div>
      <ZoneDetails key={photoVersion} zone={zone} version={photoVersion} />
      {editing ? (
        <ZoneForm label={`Modifier ${zone.name}`} idPrefix={id} initial={{ name: zone.name, indication: zone.indication ?? '' }} submitLabel="Enregistrer" busy={busy}
          onSubmit={(v) => onAction(() => updateZone(zone.id, v), () => setEditing(false))} onCancel={() => setEditing(false)} />
      ) : (
        <div className="zone-row__actions">
          <Button variant="link" disabled={busy} onClick={() => setEditing(true)}>Modifier</Button>
          <Button variant="link" disabled={busy} onClick={confirmDelete}>Supprimer</Button>
        </div>
      )}
      <div className="zone-row__actions">
        <label className="field__label" htmlFor={`${id}-photo`}>{zone.hasPhoto ? 'Changer la photo' : 'Ajouter une photo'}</label>
        <input id={`${id}-photo`} type="file" accept="image/*" capture="environment" aria-label={`Photo de ${zone.name}`} disabled={busy} onChange={pickPhoto} />
        {zone.hasPhoto && <Button variant="link" disabled={busy} onClick={() => onAction(() => removeZonePhoto(zone.id))}>Retirer la photo</Button>}
      </div>
    </li>
  );
}

/**
 * Zones de la cave : nom, indication, photo, ordre d'affichage (↑ ↓). Toutes
 * les erreurs de l'api sont montrées telles quelles.
 */
function ZonesCard() {
  const qc = useQueryClient();
  const zones = useZones();
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Version de la photo de chaque zone remplacée ici : la nouvelle image est relue sous la même adresse.
  const [versions, setVersions] = useState<Record<string, number>>({});
  // Clé du formulaire d'ajout : changée après un ajout réussi, pour le vider.
  const [addKey, setAddKey] = useState(0);
  const list = zones.data ?? [];

  async function act(run: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await run();
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible');
    } finally {
      setBusy(false);
      // Zones et libellés (emplacements, fiches, cave) suivent un renommage ou un nouvel ordre.
      void qc.invalidateQueries({ predicate: (q) => ['zones', 'locations', 'wine', 'cave', 'movements'].includes(String(q.queryKey[0])) });
    }
  }

  function move(index: number, delta: -1 | 1) {
    const ids = list.map((z) => z.id);
    const target = index + delta;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void act(() => reorderZones(ids));
  }

  return (
    <section className="card" aria-labelledby={titleId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <h2 id={titleId} style={{ fontSize: 18, margin: 0 }}>Zones</h2>
      <p className="list__meta" style={{ margin: 0 }}>Les endroits de la cave où ranger les bouteilles. L’indication et la photo aident à les retrouver.</p>
      {zones.isError && <p role="alert" className="text-error">{(zones.error as Error).message}</p>}
      {zones.data?.length === 0 && <p className="list__meta">Aucune zone pour l’instant.</p>}
      {list.length > 0 && (
        <ul className="zone-list">
          {list.map((z, i) => (
            <ZoneRow key={z.id} zone={z} index={i} count={list.length} busy={busy} photoVersion={versions[z.id]}
              onMove={(d) => move(i, d)} onAction={(run, after) => void act(run, after)}
              onPhotoChanged={() => setVersions((v) => ({ ...v, [z.id]: Date.now() }))} />
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-error" style={{ margin: 0 }}>{error}</p>}
      <ZoneForm key={addKey} label="Ajouter une zone" idPrefix={`${titleId}-new`} initial={{ name: '', indication: '' }} submitLabel="Ajouter une zone" busy={busy}
        onSubmit={(v) => void act(() => createZone(v), () => setAddKey((k) => k + 1))} />
    </section>
  );
}

/** Propriétaire : nom de la cave, zones, puis membres en lecture seule (inviter, retirer). */
export function MaCavePage() {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: getMembers });
  const [email, setEmail] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['members'] });
  const invite = useMutation({
    mutationFn: (address: string) => inviteMember(address),
    onMutate: (): void => remove.reset(),
    onSuccess: () => {
      setEmail('');
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeMember(id),
    onMutate: (): void => invite.reset(),
    onSuccess: refresh,
  });

  function submitInvite(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) invite.mutate(email.trim());
  }

  function confirmRemove(m: MemberView) {
    if (window.confirm(`Retirer ${m.email} de la cave ?`)) remove.mutate(m.id);
  }

  const error = (invite.error ?? remove.error) as Error | null;

  return (
    <>
      <TopBar title="Ma cave" back="/" />
      <main className="page">
        <RenameCard />

        <ZonesCard />

        <section className="card" aria-labelledby="members-title">
          <h2 id="members-title" style={{ fontSize: 18 }}>Membres</h2>
          <p className="list__meta">Un membre invité voit la cave, les fiches et les statistiques, sans les prix ni le journal, et ne peut rien modifier.</p>
          <form onSubmit={submitInvite} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label className="field__label" htmlFor="invite-email">Adresse e-mail</label>
            <input id="invite-email" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button type="submit" className="btn btn--primary" disabled={!email.trim() || invite.isPending}>Inviter</button>
          </form>
          {error && <p role="alert" className="text-error">{error.message}</p>}
          {members.isError && <p role="alert" className="text-error">{(members.error as Error).message}</p>}
          <div className="list">
            {members.data?.map((m) => <MemberRow key={m.id} member={m} busy={remove.isPending} onRemove={confirmRemove} />)}
          </div>
        </section>
      </main>
      <BottomNav />
    </>
  );
}
