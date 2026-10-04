import { ChangeEvent, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { uploadPhoto } from '../lib/api-client';

export function SortieCapturePage() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const lastFile = useRef<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { id } = await uploadPhoto(file, 'EXIT');
      navigate(`/sortie/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Envoi impossible');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    lastFile.current = file;
    await send(file);
  }

  async function retry() {
    if (lastFile.current) await send(lastFile.current);
  }

  return (
    <>
      <TopBar title="Sortir une bouteille" back="/" />
      <main className="page capture">
        <p style={{ textAlign: 'center', color: 'var(--color-secondary)' }}>Photographiez l’étiquette de la bouteille.</p>
        <input ref={input} className="capture__input" type="file" accept="image/*" capture="environment" onChange={onFile} aria-label="Photographier l’étiquette" />
        <Button variant="dark" onClick={() => input.current?.click()} disabled={busy}>
          <Icon name="photo_camera" />
          {busy ? 'Envoi…' : 'Prendre la photo'}
        </Button>
        {error && (
          <>
            <p role="alert" className="text-error">{error}</p>
            <Button variant="dark" onClick={retry} disabled={busy}>Réessayer l’envoi</Button>
            <Link to="/cave" className="btn btn--outline">Chercher dans la cave</Link>
          </>
        )}
      </main>
    </>
  );
}
