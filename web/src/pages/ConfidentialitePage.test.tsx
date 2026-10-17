import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfidentialitePage } from './ConfidentialitePage';

it('présente les règles de confidentialité sans connexion, avec les services tiers', () => {
  render(<MemoryRouter><ConfidentialitePage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Règles de confidentialité de Ma Cave' })).toBeInTheDocument();
  expect(screen.getByText(/Google Gemini/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Retour à la connexion' })).toHaveAttribute('href', '/login');
});
