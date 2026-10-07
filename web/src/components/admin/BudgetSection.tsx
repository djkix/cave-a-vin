import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { getAdminBudget, putAdminBudget } from '../../lib/api-client';

const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const euros = (cents: number) => EUR.format(cents / 100);

/** Part de 0 à 100 %, entière ; l'api la reçoit en fraction (0 à 1). */
function parsePercent(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 0 && n <= 100 ? n : null;
}

type Share = 'caveShare' | 'invitedShare';
const FIELDS: { key: Share; label: string }[] = [
  { key: 'caveShare', label: 'Part maximale par cave (%)' },
  { key: 'invitedShare', label: 'Part maximale de l’ensemble des caves invitées (%)' },
];

export function BudgetSection() {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ['admin', 'budget'], queryFn: getAdminBudget });
  // Brouillons : absents tant que rien n'est saisi, la valeur enregistrée est alors affichée.
  const [drafts, setDrafts] = useState<Partial<Record<Share, string>>>({});
  const save = useMutation({
    mutationFn: (shares: { caveShare: number; invitedShare: number }) => putAdminBudget(shares),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'budget'], data);
      setDrafts({});
    },
  });
  const value = (key: Share) => drafts[key] ?? (budget.data ? String(Math.round(budget.data[key] * 100)) : '');
  const pct = { caveShare: parsePercent(value('caveShare')), invitedShare: parsePercent(value('invitedShare')) };
  const invalid = (key: Share) => budget.data !== undefined && pct[key] === null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pct.caveShare !== null && pct.invitedShare !== null) {
      save.mutate({ caveShare: pct.caveShare / 100, invitedShare: pct.invitedShare / 100 });
    }
  }

  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Budget</h2>
      {budget.isError && <p role="alert" className="text-error">{(budget.error as Error).message}</p>}
      {budget.data && (
        <p className="num" style={{ margin: 'var(--space-xs) 0' }}>
          Dépensé ce mois : {euros(budget.data.spentThisMonthCents)} sur {euros(budget.data.capCents)}
        </p>
      )}
      <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--space-sm)' }}>
        {FIELDS.map(({ key, label }) => (
          <div key={key} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'center' }}>
            <label htmlFor={`budget-${key}`} className="field__label">{label}</label>
            <input
              id={`budget-${key}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={value(key)}
              onChange={(e) => { setDrafts((d) => ({ ...d, [key]: e.target.value })); save.reset(); }}
              aria-invalid={invalid(key)}
              aria-describedby={invalid(key) ? `budget-${key}-error` : undefined}
              style={{ width: 96 }}
            />
            {invalid(key) && <p id={`budget-${key}-error`} className="text-error" style={{ width: '100%' }}>Entrez un pourcentage entier entre 0 et 100</p>}
          </div>
        ))}
        <button type="submit" className="btn btn--outline" disabled={!budget.data || pct.caveShare === null || pct.invitedShare === null || save.isPending}>Enregistrer</button>
      </form>
      {save.isError && <p role="alert" className="text-error">{(save.error as Error).message}</p>}
      {save.isSuccess && <p role="status" className="list__meta">Parts enregistrées</p>}
      <p className="list__meta">La cave de l’administrateur principal n’est pas limitée : les caves invitées, ensemble, lui laissent le reste du plafond.</p>
    </section>
  );
}
