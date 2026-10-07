import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { TopBar } from '../components/TopBar';
import { getMembers, inviteMember, MemberView, removeMember, renameCave } from '../lib/api-client';
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
      <input id="cave-name" value={value} maxLength={200} onChange={(e) => { setDraft(e.target.value); rename.reset(); }} />
      {cave && invalid && <p className="text-error" style={{ margin: 0 }}>{NAME_ERROR}</p>}
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

/** Propriétaire : renommer sa cave, inviter des membres en lecture seule, les retirer. */
export function MembresPage() {
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
      <TopBar title="Membres" back="/" />
      <main className="page">
        <RenameCard />

        <section className="card">
          <h2 style={{ fontSize: 18 }}>Inviter</h2>
          <p className="list__meta">Un membre invité voit la cave, les fiches et les statistiques, sans les prix ni le journal, et ne peut rien modifier.</p>
          <form onSubmit={submitInvite} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label className="field__label" htmlFor="invite-email">Adresse e-mail</label>
            <input id="invite-email" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button type="submit" className="btn btn--primary" disabled={!email.trim() || invite.isPending}>Inviter</button>
          </form>
        </section>

        {error && <p role="alert" className="text-error">{error.message}</p>}
        {members.isError && <p role="alert" className="text-error">{(members.error as Error).message}</p>}
        <div className="list">
          {members.data?.map((m) => <MemberRow key={m.id} member={m} busy={remove.isPending} onRemove={confirmRemove} />)}
        </div>
      </main>
      <BottomNav />
    </>
  );
}
