import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditableField } from './EditableField';

function Harness({ onChange }: { onChange: (v: string) => void }) {
  const [v, setV] = useState('2019');
  return <EditableField label="Millésime" value={v} confidence={0.42} onChange={(x) => { onChange(x); setV(x); }} type="number" />;
}

it('highlights low confidence and forwards edits', async () => {
  const onChange = vi.fn();
  const { container } = render(<Harness onChange={onChange} />);
  expect(container.querySelector('.field--low')).not.toBeNull();
  expect(screen.getByText('42 %')).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText(/Millésime/));
  await userEvent.type(screen.getByLabelText(/Millésime/), '2020');
  expect(onChange).toHaveBeenLastCalledWith('2020');
});
