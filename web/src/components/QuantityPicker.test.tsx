import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuantityPicker } from './QuantityPicker';

it('offers 1/6/12/18 and a free value, preselecting the detected quantity', async () => {
  const onChange = vi.fn();
  render(<QuantityPicker value={6} detected={6} onChange={onChange} />);
  expect(screen.getByRole('button', { name: /^6/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/Détecté sur carton : 6/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^12/ }));
  expect(onChange).toHaveBeenCalledWith(12);
  await userEvent.click(screen.getByRole('button', { name: /Autre/ }));
  await userEvent.clear(screen.getByRole('spinbutton', { name: /Quantité libre/ }));
  await userEvent.type(screen.getByRole('spinbutton', { name: /Quantité libre/ }), '3');
  expect(onChange).toHaveBeenLastCalledWith(3);
});
