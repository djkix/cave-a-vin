import { CSSProperties } from 'react';

/**
 * Icône Material Symbols. Toujours `aria-hidden` : la ligature est du texte, elle
 * polluerait sinon le nom accessible du bouton ou du lien qui la contient.
 */
export function Icon({ name, className, style }: { name: string; className?: string; style?: CSSProperties }) {
  return (
    <span className={`material-symbols-outlined ${className ?? ''}`} aria-hidden="true" style={style}>
      {name}
    </span>
  );
}
