import { useEffect, useState } from 'react';

const PRESETS = [
  { n: 1, label: 'btl' },
  { n: 6, label: 'Carton' },
  { n: 12, label: 'Caisse' },
  { n: 18, label: 'Lot' },
];

export function QuantityPicker({ value, detected, onChange }: { value: number; detected?: number | null; onChange: (n: number) => void }) {
  const [free, setFree] = useState(!PRESETS.some((p) => p.n === value));
  // Buffer the free-quantity text locally (see EditableField for why): the
  // input types as raw text so backspacing to empty doesn't get coerced back
  // to a number mid-edit, and re-syncs from `value` when the parent pushes
  // a new one.
  const [freeText, setFreeText] = useState(String(value));
  useEffect(() => setFreeText(String(value)), [value]);

  function selectPreset(n: number) {
    setFree(false);
    onChange(n);
  }

  function handleFreeChange(raw: string) {
    setFreeText(raw);
    onChange(Math.max(1, Number(raw) || 1));
  }

  return (
    <section className="card" aria-label="Quantité à intégrer">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong className="num">Quantité à intégrer</strong>
        {detected ? <span className="badge badge--ok">Détecté sur carton : {detected}</span> : null}
      </div>
      <div className="pills">
        {PRESETS.map((p) => (
          <button key={p.n} type="button" className={`pill${!free && value === p.n ? ' pill--active' : ''}`} aria-pressed={!free && value === p.n} onClick={() => selectPreset(p.n)}>
            {p.n}
            <small>{p.label}</small>
          </button>
        ))}
        <button type="button" className={`pill${free ? ' pill--active' : ''}`} aria-pressed={free} onClick={() => setFree(true)}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit</span>
          <small>Autre</small>
        </button>
      </div>
      {free && (
        <label style={{ display: 'block', marginTop: 8 }}>
          <span className="field__label">Quantité libre</span>
          <input type="number" min={1} inputMode="numeric" aria-label="Quantité libre" value={freeText} onChange={(e) => handleFreeChange(e.target.value)} />
        </label>
      )}
    </section>
  );
}
