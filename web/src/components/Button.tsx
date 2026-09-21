import { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'dark' | 'outline' | 'link';

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" {...props} className={`btn btn--${variant} ${className}`.trim()} />;
}
