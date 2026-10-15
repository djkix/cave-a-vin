import { useQueryClient } from '@tanstack/react-query';
import { FormEvent, useId, useMemo, useRef, useState } from 'react';
import { LocationInput, moveWine, Place, Zone } from '../lib/api-client';
import { EMPTY_LOCATION, toLocationInput, useLocations, usePlan, useZones } from '../lib/locations';
import { Button } from './Button';
import { Icon } from './Icon';
import { LocationFields, ZoneDetails } from './LocationFields';
import { ZonePlan } from './PlanView';

/**
 * Un endroit du vin ; touché, il montre ou cache l'indication et la photo de sa
 * zone, puis le plan avec son repère (pour tous, membre compris). Le plan n'est
 * lu que pour une zone qui a un repère.
 */
function PlaceItem({ place, zone }: { place: Place; zone: Zone | undefined }) {
  const [open, setOpen] = useState(false);
  const plan = usePlan(!!zone?.marker);
  const onPlan = !!zone?.marker && !!plan.data?.markers.some((m) => m.zoneId === zone.id);
  const detailsId = useId();
  const text = (
    <>
      <span className="locations-list__label">{place.label}</span>
      <span className="num">{` × ${place.quantity}`}</span>
    </>
  );
  if (!zone || (!zone.indication && !zone.hasPhoto && !onPlan)) return <li>{text}</li>;
  return (
    <li className="locations-list__item--zone">
      <button type="button" className="locations-list__toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((o) => !o)}>
        {text}
      </button>
      <div id={detailsId}>{open && <><ZoneDetails zone={zone} />{onPlan && <ZonePlan zoneId={zone.id} />}</>}</div>
    </li>
  );
}

/** Contenu de la fenêtre « Emplacement » : chaque endroit, la photo et l'indication de sa zone, puis le plan. */
function PlaceDetails({ place, zone }: { place: Place; zone: Zone | undefined }) {
  const plan = usePlan(!!zone?.marker);
  const onPlan = !!zone?.marker && !!plan.data?.markers.some((m) => m.zoneId === zone.id);
  return (
    <li>
      <p className="locations-list__label" style={{ margin: 0 }}>{place.label}<span className="num">{` × ${place.quantity}`}</span></p>
      <ZoneDetails zone={zone} />
      {onPlan && zone && <ZonePlan zoneId={zone.id} />}
    </li>
  );
}

/**
 * Icône d'emplacement de l'en-tête de la fiche : ouvre une fenêtre avec la photo
 * de l'emplacement (zone), son indication et le plan. `<dialog>` natif : focus,
 * Échap et fond gérés par le navigateur.
 */
export function LocationButton({ places }: { places: Place[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const zones = useZones();
  const titleId = useId();
  return (
    <>
      <button type="button" className="wine-head__location" aria-label="Voir l’emplacement" onClick={() => { setOpen(true); dialog.current?.showModal(); }}>
        <Icon name="location_on" />
      </button>
      <dialog ref={dialog} className="location-dialog" aria-labelledby={titleId} onClose={() => setOpen(false)}>
        <h2 id={titleId} style={{ fontSize: 18, marginTop: 0 }}>Emplacement</h2>
        {open && (
          <ul className="locations-list">
            {places.map((p) => <PlaceDetails key={p.id ?? ''} place={p} zone={zones.data?.find((z) => z.id === p.zoneId)} />)}
          </ul>
        )}
        <form method="dialog"><Button type="submit" variant="outline">Fermer</Button></form>
      </dialog>
    </>
  );
}

/**
 * Section « Emplacements » de la fiche (vin en stock) : chaque endroit et sa quantité, pour
 * tous, avec le détail de sa zone au toucher ; « Ranger / déplacer » pour le propriétaire seulement.
 */
export function LocationsBlock({ wineId, places, readOnly }: { wineId: string; places: Place[]; readOnly: boolean }) {
  const [moving, setMoving] = useState(false);
  const titleId = useId();
  const zones = useZones();
  return (
    <section className="card" aria-labelledby={titleId}>
      <h2 id={titleId} style={{ fontSize: 18, margin: 0 }}>Emplacements</h2>
      {places.length > 0 && (
        <ul className="locations-list">
          {places.map((p) => <PlaceItem key={p.id ?? ''} place={p} zone={zones.data?.find((z) => z.id === p.zoneId)} />)}
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
  const zones = useZones();
  const fromId = useId();
  const qtyId = useId();
  // Une clé par formulaire ouvert : un double envoi ne déplace qu'une fois.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [from, setFrom] = useState<string | null>(places[0].id);
  const [to, setTo] = useState<LocationInput>(EMPTY_LOCATION);
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
        <LocationFields value={to} onChange={setTo} locations={locations.data ?? []} zones={zones.data} />
      </fieldset>
      <label htmlFor={qtyId} className="field__label">Quantité</label>
      <input id={qtyId} type="number" inputMode="numeric" min={1} max={max} value={quantity} onChange={(e) => setQuantity(e.target.value.trim())} />
      {error && <p role="alert" className="text-error">{error}</p>}
      <Button variant="dark" type="submit" disabled={busy || !validQty}>Déplacer</Button>
      <Button variant="link" onClick={onClose}>Abandonner</Button>
    </form>
  );
}
