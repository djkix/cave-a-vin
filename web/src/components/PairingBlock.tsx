import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pairing, regeneratePairing } from '../lib/api-client';
import { Button } from './Button';

export const PAIRING_POLL_MS = 5000;

/** La fiche se rafraîchit tant que la génération n'a pas abouti (ou échoué). */
export function pairingPollInterval(pairing: Pairing | null | undefined): number | false {
  return !pairing || pairing.status === 'PENDING' ? PAIRING_POLL_MS : false;
}

/** `readOnly` : membre en lecture seule, qui ne relance pas la génération. */
export function PairingBlock({ wineId, pairing, readOnly = false }: { wineId: string; pairing: Pairing | null | undefined; readOnly?: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      await regeneratePairing(wineId);
      void qc.invalidateQueries({ queryKey: ['wine', wineId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Relance impossible');
    } finally {
      setBusy(false);
    }
  }

  const pending = !pairing || pairing.status === 'PENDING';
  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>Accords mets-vins</h3>
      {pending && (
        <>
          <p className="list__meta">Suggestions en préparation…</p>
          {pairing?.errorMessage && <p className="list__meta" style={{ margin: 0 }}>{pairing.errorMessage}</p>}
        </>
      )}
      {pairing?.status === 'DONE' && (
        <>
          <ul className="dish-pills">
            {pairing.dishes.map((d) => <li key={d} className="dish-pill">{d}</li>)}
          </ul>
          <p className="list__meta" style={{ margin: 0 }}>Suggestions générées par Gemini</p>
        </>
      )}
      {pairing?.status === 'FAILED' && (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>Suggestions indisponibles</p>
          {pairing.errorMessage && <p className="list__meta" style={{ margin: 0 }}>{pairing.errorMessage}</p>}
        </>
      )}
      {error && <p role="alert" className="text-error">{error}</p>}
      {pairing && !readOnly && (
        <Button variant="link" disabled={busy} onClick={regenerate}>Régénérer</Button>
      )}
    </section>
  );
}
