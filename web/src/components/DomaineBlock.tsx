import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ProducerProfile, regenerateProducer, setProducerDescription } from '../lib/api-client';
import { Button } from './Button';

export const PRODUCER_POLL_MS = 5000;
const MAX_LENGTH = 2000;

/** La fiche se rafraîchit tant que le descriptif du domaine n'a pas abouti (ou échoué). */
export function producerPollInterval(
  producerKey: string | null,
  producerProfile: ProducerProfile | null | undefined,
): number | false {
  if (!producerKey) return false;
  return !producerProfile || producerProfile.status === 'PENDING' ? PRODUCER_POLL_MS : false;
}

export function DomaineBlock({
  wineId,
  producerKey,
  producerProfile,
}: {
  wineId: string;
  producerKey: string | null;
  producerProfile: ProducerProfile | null | undefined;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!producerKey) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['wine', wineId] });

  function open() {
    setText(producerProfile?.description ?? '');
    setError(null);
    setEditing(true);
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  }

  const trimmedLength = text.trim().length;
  const saveDisabled = busy || trimmedLength === 0 || text.length > MAX_LENGTH;

  const pending = !producerProfile || producerProfile.status === 'PENDING';
  const hasOldText = Boolean(producerProfile?.status === 'PENDING' && producerProfile.description);
  const profile = producerProfile!;

  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>Le domaine</h3>

      {pending && !hasOldText && <p className="list__meta">Descriptif en préparation…</p>}

      {hasOldText && (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>{profile.description}</p>
          <p className="list__meta" style={{ margin: 0 }}>Nouveau descriptif en préparation…</p>
        </>
      )}

      {!pending && profile.status === 'DONE' && (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>{profile.description}</p>
          <p className="list__meta" style={{ margin: 0 }}>
            {profile.source === 'MANUEL' ? `Texte saisi par ${profile.updatedBy}` : 'Généré par Gemini, peut contenir des erreurs'}
          </p>
        </>
      )}

      {!pending && profile.status === 'UNKNOWN' && (
        <p className="list__meta">Domaine peu documenté : Gemini n’a pas d’information fiable.</p>
      )}

      {!pending && profile.status === 'FAILED' && (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>Descriptif indisponible</p>
          {profile.errorMessage && <p className="list__meta" style={{ margin: 0 }}>{profile.errorMessage}</p>}
        </>
      )}

      {error && <p role="alert" className="text-error">{error}</p>}

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
          <label className="field__label" htmlFor="domaine-description">Descriptif du domaine</label>
          <textarea id="domaine-description" value={text} onChange={(e) => setText(e.target.value)} rows={6} />
          <p className="list__meta" style={{ margin: 0 }}>{text.length} / {MAX_LENGTH}</p>
          <Button variant="dark" disabled={saveDisabled} onClick={() => run(() => setProducerDescription(producerKey, text.trim()))}>
            Enregistrer
          </Button>
          <Button variant="link" onClick={() => { setEditing(false); setError(null); }}>Abandonner</Button>
        </div>
      ) : (
        !pending && (
          <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
            {profile.status === 'DONE' && (
              <>
                <Button variant="outline" onClick={open}>Modifier</Button>
                <Button variant="link" disabled={busy} onClick={() => run(() => regenerateProducer(producerKey))}>
                  {profile.source === 'MANUEL' ? 'Revenir au texte généré' : 'Régénérer'}
                </Button>
              </>
            )}
            {profile.status === 'FAILED' && (
              <>
                <Button variant="link" disabled={busy} onClick={() => run(() => regenerateProducer(producerKey))}>Régénérer</Button>
                <Button variant="outline" onClick={open}>Écrire le descriptif</Button>
              </>
            )}
            {profile.status === 'UNKNOWN' && (
              <>
                <Button variant="link" disabled={busy} onClick={() => run(() => regenerateProducer(producerKey))}>Régénérer</Button>
                <Button variant="outline" onClick={open}>Écrire le descriptif</Button>
              </>
            )}
          </div>
        )
      )}
    </section>
  );
}
