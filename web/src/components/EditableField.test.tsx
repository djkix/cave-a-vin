import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditableField } from './EditableField';

it('highlights low confidence and forwards edits', async () => {
  const onChange = vi.fn();
  const { container } = render(<EditableField label="Millésime" value="2019" confidence={0.42} onChange={onChange} type="number" />);
  expect(container.querySelector('.field--low')).not.toBeNull();
  expect(screen.getByText('42 %')).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText(/Millésime/));
  await userEvent.type(screen.getByLabelText(/Millésime/), '2020');
  expect(onChange).toHaveBeenLastCalledWith('2020');
});
