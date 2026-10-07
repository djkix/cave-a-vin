import { useId } from 'react';
import type { Location, LocationParts, Place } from '../lib/api-client';
import { distinctParts, labelOf } from '../lib/locations';

const FIELDS: Array<{ key: keyof LocationParts; label: string }> = [
  { key: 'zone', label: 'Zone' }, { key: 'casier', label: 'Casier' }, { key: 'position', label: 'Position' },
];

/** Zone / casier / position, chacun avec les valeurs déjà utilisées dans la cave en suggestion (`<datalist>`). */
export function LocationFields({ value, onChange, locations }: { value: LocationParts; onChange: (v: LocationParts) => void; locations: Location[] }) {
  const id = useId();
  const suggestions = distinctParts(locations);
  return (
    <div className="location-fields">
      {FIELDS.map(({ key, label }) => (
        <label key={key} className="field__label">
          {label}
          <input
            value={value[key] ?? ''}
            maxLength={40}
            list={`${id}-${key}`}
            autoComplete="off"
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
          <datalist id={`${id}-${key}`}>
            {suggestions[key].map((v) => <option key={v} value={v} />)}
          </datalist>
        </label>
      ))}
    </div>
  );
}

/** Bloc replié « Emplacement » de l'entrée : le titre montre l'emplacement retenu, pré-rempli ou saisi. */
export function EntryLocationBlock({ value, onChange, locations }: { value: LocationParts; onChange: (v: LocationParts) => void; locations: Location[] }) {
  return (
    <details className="card location-block">
      <summary>
        Emplacement
        <span className="list__meta location-block__current">{labelOf(value)}</span>
      </summary>
      <LocationFields value={value} onChange={onChange} locations={locations} />
    </details>
  );
}

/** « D'où sort-elle ? » (ou la légende donnée) : un bouton radio par endroit, avec sa quantité. */
export function PlacePicker({ places, value, onChange, legend = 'D\'où sort-elle ?' }: { places: Place[]; value: string | null; onChange: (id: string | null) => void; legend?: string }) {
  const name = useId();
  return (
    <fieldset className="place-picker">
      <legend>{legend}</legend>
      {places.map((p) => (
        <label key={p.id ?? ''} className="place-picker__option">
          <input type="radio" name={name} checked={value === p.id} onChange={() => onChange(p.id)} />
          {`${p.label} · ${p.quantity}`}
        </label>
      ))}
    </fieldset>
  );
}
