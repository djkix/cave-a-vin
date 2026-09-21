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
  expect(screen.getByRole('alert')).toHaveTextContent('Connexion refusée. Si votre compte a été bloqué, contactez l’administrateur.');
});

it('explains that the session could not be created', () => {
  mount('/login?error=session');
  expect(screen.getByRole('alert')).toHaveTextContent('La session n’a pas pu être créée. Réessayez.');
});

it('says nothing for an unknown error value or no error at all', () => {
  mount('/login?error=autre-chose');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  mount('/login');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
