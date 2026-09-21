import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { APP_VERSION } from '../lib/version';
import { TopBar } from './TopBar';

function mount(props: { title?: string; back?: string } = {}) {
  return render(
    <MemoryRouter>
      <TopBar {...props} />
    </MemoryRouter>,
  );
}

it('affiche la version sur l’écran d’accueil', () => {
  mount();
  expect(screen.getByLabelText(`Version ${APP_VERSION}`)).toHaveTextContent(`v${APP_VERSION}`);
});

it('affiche la version aussi sur un écran interne, avec son bouton de retour', () => {
  mount({ title: 'Revue groupée', back: '/entree' });
  expect(screen.getByRole('link', { name: 'Retour' })).toBeInTheDocument();
  expect(screen.getByLabelText(`Version ${APP_VERSION}`)).toBeInTheDocument();
});

it('annonce « dev » quand aucune version n’a été injectée à la construction', () => {
  // Les tests tournent sans VITE_APP_VERSION : c'est exactement le cas d'une
  // construction locale, qui ne doit jamais afficher un numéro inventé.
  expect(APP_VERSION).toBe('dev');
});
