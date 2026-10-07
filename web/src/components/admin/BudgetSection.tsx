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

export function BudgetSection() {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ['admin', 'budget'], queryFn: getAdminBudget });
  // Brouillon : nul tant que rien n'est saisi, la valeur enregistrée est alors affichée.
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (share: number) => putAdminBudget(share),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'budget'], data);
      setDraft(null);
    },
  });
  const current = budget.data ? String(Math.round(budget.data.caveShare * 100)) : '';
  const value = draft ?? current;
  const pct = parsePercent(value);
  const invalid = budget.data !== undefined && pct === null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pct !== null) save.mutate(pct / 100);
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
      <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'center' }}>
        <label htmlFor="budget-share" className="field__label">Part maximale par cave (%)</label>
        <input
          id="budget-share"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => { setDraft(e.target.value); save.reset(); }}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'budget-share-error' : undefined}
          style={{ width: 96 }}
        />
        <button type="submit" className="btn btn--outline" disabled={!budget.data || pct === null || save.isPending}>Enregistrer</button>
      </form>
      {invalid && <p id="budget-share-error" className="text-error">Entrez un pourcentage entier entre 0 et 100</p>}
      {save.isError && <p role="alert" className="text-error">{(save.error as Error).message}</p>}
      {save.isSuccess && <p role="status" className="list__meta">Part enregistrée</p>}
      <p className="list__meta">La cave de l’administrateur principal n’est pas limitée.</p>
    </section>
  );
}
