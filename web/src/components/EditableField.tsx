import { useId } from 'react';
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
  return (
    <div className={`field${low ? ' field--low' : ''}${serif ? ' field--serif' : ''}`}>
      <label htmlFor={id} className="field__label">
        {label}
        {confidence !== undefined && <ConfidenceBadge confidence={confidence} />}
      </label>
      {options ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input id={id} type={type} inputMode={type === 'number' ? 'numeric' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
