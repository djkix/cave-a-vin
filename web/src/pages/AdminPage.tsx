import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { TopBar } from '../components/TopBar';
import { BudgetSection } from '../components/admin/BudgetSection';
import { GuardsSection } from '../components/admin/GuardsSection';
import { ReadingQualitySection } from '../components/admin/ReadingQualitySection';
import { RegistrationsSection } from '../components/admin/RegistrationsSection';
import { VintagesSection } from '../components/admin/VintagesSection';
import { AdminUser, createUserCave, getAdminUsers, updateAdminUser } from '../lib/api-client';
import { useMe } from '../lib/use-current-cave';

const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function AdminUserRow({ user, isSelf, onToggleStatus, onToggleAdmin, onCreateCave, pending }: {
  user: AdminUser;
  isSelf: boolean;
  onToggleStatus: (u: AdminUser) => void;
  onToggleAdmin: (u: AdminUser) => void;
  onCreateCave: (u: AdminUser) => void;
  pending: boolean;
}) {
  return (
    <div className="list__row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="list__title" style={{ margin: 0 }}>
          {user.displayName ?? user.email}
          {user.isAdmin && <span className="badge badge--ok" style={{ marginLeft: 'var(--space-sm)' }}>Administrateur</span>}
          {user.status === 'BLOCKED' && <span className="badge badge--warn" style={{ marginLeft: 'var(--space-sm)' }}>Bloqué</span>}
          {user.status === 'PENDING' && <span className="badge badge--warn" style={{ marginLeft: 'var(--space-sm)' }}>En attente</span>}
        </p>
        <span className="list__meta">{user.email}</span>
        <br />
        <span className="list__meta">
          Créé le {fmt.format(new Date(user.createdAt))} · Dernière connexion{' '}
          {user.lastLoginAt ? fmt.format(new Date(user.lastLoginAt)) : 'jamais'}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        <Button variant="outline" disabled={isSelf || pending} onClick={() => onToggleStatus(user)}>
          {user.status === 'BLOCKED' ? 'Réactiver' : 'Bloquer'}
        </Button>
        <Button variant="outline" disabled={isSelf || pending} onClick={() => onToggleAdmin(user)}>
          {user.isAdmin ? 'Retirer les droits' : 'Promouvoir administrateur'}
        </Button>
        {/* Compte actif sans cave à lui (invité seulement, ou validé à la main) : l'administrateur peut la créer. */}
        {user.status === 'ACTIVE' && !user.hasCave && (
          <Button variant="outline" disabled={pending} onClick={() => onCreateCave(user)}>Créer sa cave</Button>
        )}
        {isSelf && <span className="list__meta">votre compte</span>}
      </div>
    </div>
  );
}

export function AdminPage() {
  const qc = useQueryClient();
  const me = useMe();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: getAdminUsers, enabled: me.data?.isAdmin === true });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { status?: AdminUser['status']; isAdmin?: boolean } }) => updateAdminUser(id, patch),
    onMutate: (): void => createCave.reset(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
  // La cave créée peut être celle de l'administrateur lui-même : on relit aussi la session.
  const createCave = useMutation({
    mutationFn: (id: string) => createUserCave(id),
    onMutate: (): void => update.reset(),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'users'] }), qc.invalidateQueries({ queryKey: ['me'] })]),
  });
  const rowError = (update.error ?? createCave.error) as Error | null;

  return (
    <>
      <TopBar title="Administration" back="/" />
      <main className="page">
        {me.data && !me.data.isAdmin && <p className="centered">Réservé à l’administrateur.</p>}
        {me.data?.isAdmin && (
          <>
            <RegistrationsSection />
            {rowError && <p role="alert" className="text-error">{rowError.message}</p>}
            {users.isError && <p role="alert" className="text-error">{(users.error as Error).message}</p>}
            <div className="list">
              {users.data?.map((u) => (
                <AdminUserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === me.data.id}
                  pending={update.isPending || createCave.isPending}
                  onToggleStatus={(user) => update.mutate({ id: user.id, patch: { status: user.status === 'BLOCKED' ? 'ACTIVE' : 'BLOCKED' } })}
                  onToggleAdmin={(user) => update.mutate({ id: user.id, patch: { isAdmin: !user.isAdmin } })}
                  onCreateCave={(user) => createCave.mutate(user.id)}
                />
              ))}
              {users.data?.length === 0 && <p className="centered">Aucun compte.</p>}
            </div>
            <BudgetSection />
            <ReadingQualitySection />
            <VintagesSection />
            <GuardsSection />
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
