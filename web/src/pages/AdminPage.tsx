import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { TopBar } from '../components/TopBar';
import { AdminUser, getAdminUsers, getMe, updateAdminUser } from '../lib/api-client';

const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function AdminUserRow({ user, isSelf, onToggleStatus, onToggleAdmin, pending }: {
  user: AdminUser;
  isSelf: boolean;
  onToggleStatus: (u: AdminUser) => void;
  onToggleAdmin: (u: AdminUser) => void;
  pending: boolean;
}) {
  return (
    <div className="list__row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="list__title" style={{ margin: 0 }}>
          {user.displayName ?? user.email}
          {user.isAdmin && <span className="badge badge--ok" style={{ marginLeft: 'var(--space-sm)' }}>Administrateur</span>}
          {user.status === 'BLOCKED' && <span className="badge badge--warn" style={{ marginLeft: 'var(--space-sm)' }}>Bloqué</span>}
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
        {isSelf && <span className="list__meta">votre compte</span>}
      </div>
    </div>
  );
}

export function AdminPage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: getMe });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: getAdminUsers, enabled: me.data?.isAdmin === true });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { status?: AdminUser['status']; isAdmin?: boolean } }) => updateAdminUser(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  return (
    <>
      <TopBar title="Administration" back="/" />
      <main className="page">
        {me.data && !me.data.isAdmin && <p className="centered">Réservé à l’administrateur.</p>}
        {me.data?.isAdmin && (
          <>
            {update.isError && <p role="alert" className="text-error">{(update.error as Error).message}</p>}
            <div className="list">
              {users.data?.map((u) => (
                <AdminUserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === me.data.id}
                  pending={update.isPending}
                  onToggleStatus={(user) => update.mutate({ id: user.id, patch: { status: user.status === 'BLOCKED' ? 'ACTIVE' : 'BLOCKED' } })}
                  onToggleAdmin={(user) => update.mutate({ id: user.id, patch: { isAdmin: !user.isAdmin } })}
                />
              ))}
              {users.data?.length === 0 && <p className="centered">Aucun compte.</p>}
            </div>
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
