import { ChangeEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { TopBar } from '../components/TopBar';
import { uploadPhoto } from '../lib/api-client';

export function EntreeCapturePage() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await uploadPhoto(file);
      navigate(`/entree/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Envoi impossible');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  return (
    <>
      <TopBar title="Rentrer du vin" back="/" />
      <main className="page capture">
        <p style={{ textAlign: 'center', color: 'var(--color-secondary)' }}>
          Photographiez le carton (mentions imprimées) ou l’étiquette d’une bouteille.
        </p>
        <input ref={input} className="capture__input" type="file" accept="image/*" capture="environment" onChange={onFile} aria-label="Prendre une photo" />
        <Button variant="primary" onClick={() => input.current?.click()} disabled={busy} style={{ width: '100%', minHeight: 'var(--size-action-height)' }}>
          <span className="material-symbols-outlined">photo_camera</span>
          {busy ? 'Envoi…' : 'Prendre la photo'}
        </Button>
        {error && <p role="alert" className="text-error">{error}</p>}
      </main>
    </>
  );
}
