import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuantityPicker } from './QuantityPicker';

function Harness({ onChange }: { onChange: (n: number) => void }) {
  const [v, setV] = useState(6);
  return <QuantityPicker value={v} detected={6} onChange={(n) => { onChange(n); setV(n); }} />;
}

it('offers 1/6/12/18 and a free value, preselecting the detected quantity', async () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  expect(screen.getByRole('button', { name: /^6/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/Détecté sur carton : 6/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^12/ }));
  expect(onChange).toHaveBeenCalledWith(12);
  await userEvent.click(screen.getByRole('button', { name: /Autre/ }));
  await userEvent.clear(screen.getByRole('spinbutton', { name: /Quantité libre/ }));
  await userEvent.type(screen.getByRole('spinbutton', { name: /Quantité libre/ }), '3');
  expect(onChange).toHaveBeenLastCalledWith(3);
});

it('commits a clamped value on blur when the free field is invalid', async () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  await userEvent.click(screen.getByRole('button', { name: /Autre/ }));
  const input = screen.getByRole('spinbutton', { name: /Quantité libre/ });
  await userEvent.clear(input);
  await userEvent.type(input, '0');
  await userEvent.tab();
  expect(onChange).toHaveBeenLastCalledWith(1);
  expect(input).toHaveValue(1);
});
