import { useQueryClient } from '@tanstack/react-query';
import { FormEvent, useId, useMemo, useState } from 'react';
import { LocationParts, moveWine, Place } from '../lib/api-client';
import { EMPTY_LOCATION, toLocationInput, useLocations } from '../lib/locations';
import { Button } from './Button';
import { LocationFields } from './LocationFields';

/**
 * Section « Emplacements » de la fiche (vin en stock) : chaque endroit et sa quantité, pour
 * tous ; « Ranger / déplacer » pour le propriétaire seulement.
 */
export function LocationsBlock({ wineId, places, readOnly }: { wineId: string; places: Place[]; readOnly: boolean }) {
  const [moving, setMoving] = useState(false);
  const titleId = useId();
  return (
    <section className="card" aria-labelledby={titleId}>
      <h2 id={titleId} style={{ fontSize: 18, margin: 0 }}>Emplacements</h2>
      {places.length > 0 && (
        <ul className="locations-list">
          {places.map((p) => (
            <li key={p.id ?? ''}>
              <span className="locations-list__label">{p.label}</span>
              <span className="num">{` × ${p.quantity}`}</span>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && places.length > 0 && (moving
        ? <MoveForm wineId={wineId} places={places} onClose={() => setMoving(false)} />
        : <Button variant="outline" onClick={() => setMoving(true)}>Ranger / déplacer</Button>)}
    </section>
  );
}

function MoveForm({ wineId, places, onClose }: { wineId: string; places: Place[]; onClose: () => void }) {
  const qc = useQueryClient();
  const locations = useLocations();
  const fromId = useId();
  const qtyId = useId();
  // Une clé par formulaire ouvert : un double envoi ne déplace qu'une fois.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [from, setFrom] = useState<string | null>(places[0].id);
  const [to, setTo] = useState<LocationParts>(EMPTY_LOCATION);
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = places.find((p) => p.id === from)?.quantity ?? 1;
  const n = /^\d+$/.test(quantity) ? Number(quantity) : NaN;
  const validQty = n >= 1 && n <= max;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !validQty) return;
    setBusy(true);
    setError(null);
    try {
      // Destination entièrement vide : l'api répond par son message (« Indiquez au moins… »).
      await moveWine(wineId, { idempotencyKey, from, to: toLocationInput(to) ?? EMPTY_LOCATION, quantity: n });
      void qc.invalidateQueries({ predicate: (q) => ['cave', 'wine', 'movements', 'locations'].includes(String(q.queryKey[0])) });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Déplacement impossible');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Ranger / déplacer" onSubmit={submit} className="move-form">
      <label htmlFor={fromId} className="field__label">De</label>
      <select id={fromId} value={from ?? ''} onChange={(e) => setFrom(e.target.value || null)}>
        {places.map((p) => <option key={p.id ?? ''} value={p.id ?? ''}>{`${p.label} · ${p.quantity}`}</option>)}
      </select>
      <fieldset className="move-form__to">
        <legend className="field__label">Vers</legend>
        <LocationFields value={to} onChange={setTo} locations={locations.data ?? []} />
      </fieldset>
      <label htmlFor={qtyId} className="field__label">Quantité</label>
      <input id={qtyId} type="number" inputMode="numeric" min={1} max={max} value={quantity} onChange={(e) => setQuantity(e.target.value.trim())} />
      {error && <p role="alert" className="text-error">{error}</p>}
      <Button variant="dark" type="submit" disabled={busy || !validQty}>Déplacer</Button>
      <Button variant="link" onClick={onClose}>Abandonner</Button>
    </form>
  );
}
