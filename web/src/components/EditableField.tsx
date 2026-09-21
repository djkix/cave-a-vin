import { useEffect, useId, useState } from 'react';
import { ConfidenceBadge, LOW_CONFIDENCE } from './ConfidenceBadge';

interface Props {
  label: string;
  value: string;
  confidence?: number;
  onChange: (value: string) => void;
  serif?: boolean;
  type?: 'text' | 'number';
  options?: { value: string; label: string }[];
}

export function EditableField({ label, value, confidence, onChange, serif, type = 'text', options }: Props) {
  const id = useId();
  const low = confidence !== undefined && confidence < LOW_CONFIDENCE;
  // Buffer the edited value locally so typing accumulates immediately: a
  // controlled <input> whose `value` never changes (parent hasn't re-rendered
  // with the latest prop yet) would otherwise have its DOM value restored by
  // React after every keystroke. Re-sync from `value` whenever the parent
  // does push a new one (e.g. an OCR re-read correcting the field).
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  function handleChange(next: string) {
    setLocal(next);
    onChange(next);
  }

  return (
    <div className={`field${low ? ' field--low' : ''}${serif ? ' field--serif' : ''}`}>
      <label htmlFor={id} className="field__label">
        {label}
        {confidence !== undefined && <ConfidenceBadge confidence={confidence} />}
      </label>
      {options ? (
        <select id={id} value={local} onChange={(e) => handleChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input id={id} type={type} inputMode={type === 'number' ? 'numeric' : 'text'} value={local} onChange={(e) => handleChange(e.target.value)} />
      )}
    </div>
  );
}
