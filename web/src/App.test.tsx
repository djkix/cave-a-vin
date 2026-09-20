import { render, screen } from '@testing-library/react';
import { App } from './App';

it('affiche le titre de l’application', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Cave & Terroir' })).toBeInTheDocument();
});
