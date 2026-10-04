import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { cancelMovement, CaveRow, createOut, MovementResult } from '../lib/api-client';
import { Button } from './Button';
import { Icon } from './Icon';
import { WineThumb } from './WineThumb';

/**
 * Seul endroit où une sortie s'écrit, depuis la fiche vin comme depuis la photo.
 * Une clé d'idempotence par affichage, un verrou contre le double tap : une
 * confirmation ne débite qu'une fois.
 */
export function SortieConfirmation({ wine, photoId, onDone }: { wine: CaveRow; photoId?: string | null; onDone?: () => void }) {
  const qc = useQueryClient();
  const [quantity, setQuantity] = useState(1);
  const [result, setResult] = useState<MovementResult | null>(null);
  const [cancelled, setCancelled] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  // Une clé par vin affiché : un nouveau vin doit recevoir une nouvelle clé.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [wine.id]);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => ['cave', 'wine', 'movements'].includes(String(q.queryKey[0])) });

  // Le stock peut se réduire sous la quantité choisie après un rafraîchissement
  // (un autre mouvement concurrent, par exemple) : on ne retient jamais plus
  // que ce qu'il reste, à l'affichage comme à l'envoi.
  const safeQuantity = Math.min(quantity, Math.max(wine.quantity, 1));

  async function sortir() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      setResult(await createOut({ idempotencyKey, wineId: wine.id, quantity: safeQuantity, photoId: photoId ?? null }));
      void refresh();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sortie impossible');
      sending.current = false;
    } finally {
      setBusy(false);
    }
  }

  async function annuler() {
    if (!result) return;
    setBusy(true);
    try {
      const r = await cancelMovement(result.movement.id, crypto.randomUUID());
      setCancelled(r.stock);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Annulation impossible');
    } finally {
      setBusy(false);
    }
  }

  if (cancelled !== null) return <p role="status" className="card">Sortie annulée — {cancelled} en stock</p>;
  if (result) {
    return (
      <section className="card" role="status">
        {/* created: false — le serveur a rejoué une sortie déjà écrite (double tap,
            même photo) : rien n'a bougé à l'instant, on ne prétend pas le contraire. */}
        <p style={{ margin: 0, fontWeight: 600 }}>
          {result.created ? 'Sorti' : 'Déjà sortie'} — il en reste {result.stock}
        </p>
        <Button variant="link" onClick={annuler} disabled={busy} aria-label="Annuler la sortie">Annuler</Button>
        {error && <p role="alert" className="text-error">{error}</p>}
      </section>
    );
  }

  // Un vin épuisé n'a pas de sortie à proposer — mais on n'atteint ce point que
  // si aucune sortie n'a encore été confirmée : le panneau de résultat, lui,
  // reste affiché même quand la sortie vient de vider le stock.
  if (wine.quantity < 1) return null;

  const max = wine.quantity;
  return (
    <section className="card">
      <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center' }}>
        <WineThumb photoId={wine.referencePhotoId} size={64} />
        <div>
          <p className="list__title" style={{ margin: 0 }}>{wine.producer}{wine.cuvee ? ` — ${wine.cuvee}` : ''}</p>
          <p className="list__meta" style={{ margin: 0 }}>{wine.appellationRaw} · {wine.vintage ?? 'NV'} · {max} en stock</p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-md)', margin: 'var(--space-md) 0' }}>
        <Button variant="outline" onClick={() => setQuantity((n) => Math.max(1, n - 1))} disabled={safeQuantity <= 1} aria-label="Une bouteille de moins">
          <Icon name="remove" />
        </Button>
        <span className="num" style={{ fontSize: 28 }}>{safeQuantity}</span>
        <Button variant="outline" onClick={() => setQuantity((n) => Math.min(max, n + 1))} disabled={safeQuantity >= max} aria-label="Une bouteille de plus">
          <Icon name="add" />
        </Button>
      </div>
      {error && <p role="alert" className="text-error">{error}</p>}
      <Button variant="dark" onClick={sortir} disabled={busy || max < 1}>
        <Icon name="remove_circle_outline" />
        {busy ? 'Sortie…' : `Sortir ${safeQuantity} bouteille${safeQuantity > 1 ? 's' : ''}`}
      </Button>
    </section>
  );
}
