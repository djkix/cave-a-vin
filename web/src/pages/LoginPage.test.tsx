import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from './LoginPage';

function mount(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

it('explains that the connection was refused (blocked account or otherwise)', () => {
  mount('/login?error=unauthorized');
  expect(screen.getByRole('alert')).toHaveTextContent('La connexion n’a pas abouti');
  expect(screen.getByRole('alert')).toHaveTextContent('contactez l’administrateur de la cave');
});

it('explains that the session could not be created', () => {
  mount('/login?error=session');
  expect(screen.getByRole('alert')).toHaveTextContent('La connexion a été interrompue');
});

it('says nothing for an unknown error value or no error at all', () => {
  mount('/login?error=autre-chose');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  mount('/login');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
