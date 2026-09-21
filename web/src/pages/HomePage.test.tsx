import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from './HomePage';

it('propose Rentrer et marque Sortir comme bientôt disponible', () => {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /Rentrer du vin/ })).toHaveAttribute('href', '/entree');
  expect(screen.getByRole('button', { name: /Sortir une bouteille/ })).toBeDisabled();
  expect(screen.getByText(/Bientôt/)).toBeInTheDocument();
});
