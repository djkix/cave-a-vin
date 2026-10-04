import { fireEvent, render, screen } from '@testing-library/react';
import { WineThumb } from './WineThumb';

it('affiche un pictogramme quand le vin n’a pas de photo', () => {
  const { container } = render(<WineThumb photoId={null} />);
  expect(screen.getByLabelText('Pas de photo')).toBeInTheDocument();
  expect(container.querySelectorAll('img')).toHaveLength(0);
});

it('affiche la photo de référence quand une photo existe', () => {
  const { container } = render(<WineThumb photoId="p1" />);
  const img = container.querySelector('img');
  expect(img).not.toBeNull();
  expect(img).toHaveAttribute('src', '/api/photos/p1/image');
});

it('retombe sur le pictogramme si l’image échoue à charger, jamais une image cassée', () => {
  const { container } = render(<WineThumb photoId="p1" />);
  const img = container.querySelector('img');
  expect(img).not.toBeNull();
  fireEvent.error(img as HTMLImageElement);
  expect(container.querySelectorAll('img')).toHaveLength(0);
  expect(screen.getByLabelText('Pas de photo')).toBeInTheDocument();
});
