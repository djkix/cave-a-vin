import { render, screen } from '@testing-library/react';
import { App } from './App';

it('rend l’application (route /login sans session)', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"message":"Connexion requise"}', { status: 401 }));
  window.history.pushState({}, '', '/');
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Cave & Terroir' })).toBeInTheDocument();
});
