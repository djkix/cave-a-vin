import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRegistrations, refuseRegistration, Registration, validateRegistration } from '../../lib/api-client';
import { Button } from '../Button';

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Valider crée le compte actif et sa cave ; refuser bloque le compte. Les deux changent aussi la liste des comptes. */
const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ['admin', 'registrations'] }),
    qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  ]);

export function RegistrationsSection() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'registrations'], queryFn: getRegistrations });
  const validate = useMutation({
    mutationFn: (id: string) => validateRegistration(id),
    onMutate: (): void => refuse.reset(),
    onSuccess: () => invalidate(qc),
  });
  const refuse = useMutation({
    mutationFn: (id: string) => refuseRegistration(id),
    onMutate: (): void => validate.reset(),
    onSuccess: () => invalidate(qc),
  });
  const busy = validate.isPending || refuse.isPending;
  const error = (validate.error ?? refuse.error ?? list.error) as Error | null;

  function confirmRefuse(r: Registration) {
    if (window.confirm(`Refuser l’inscription de ${r.email} ? Le compte sera bloqué.`)) refuse.mutate(r.id);
  }

  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Inscriptions</h2>
      {error && <p role="alert" className="text-error">{error.message}</p>}
      {list.data?.length === 0 && <p className="list__meta">Aucune inscription en attente</p>}
      {list.data && list.data.length > 0 && (
        <div className="list" style={{ marginTop: 'var(--space-sm)' }}>
          {list.data.map((r) => (
            <div key={r.id} className="list__row">
              <div style={{ flex: 1, minWidth: 0 }}>
                {r.displayName && <p className="list__title" style={{ margin: 0 }}>{r.displayName}</p>}
                <span className="list__meta" style={{ overflowWrap: 'anywhere' }}>{r.email}</span>
                <br />
                <span className="list__meta">Inscrit le {DATE.format(new Date(r.createdAt))}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                <Button variant="outline" disabled={busy} onClick={() => validate.mutate(r.id)}>Valider</Button>
                <Button variant="link" disabled={busy} onClick={() => confirmRefuse(r)}>Refuser</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
