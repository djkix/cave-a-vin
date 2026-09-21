import { Link } from 'react-router-dom';
import { TopBar } from '../components/TopBar';

/** URL inconnue (favori périmé, lien tronqué) : on nomme le problème et on ramène. */
export function NotFoundPage() {
  return (
    <>
      <TopBar title="Page introuvable" back="/" />
      <main className="page">
        <p className="centered">Cette page n’existe pas.</p>
        <Link to="/" className="btn btn--outline">Retour à l’accueil</Link>
      </main>
    </>
  );
}

/** Dernier filet du routeur : une exception de rendu ne doit pas laisser un écran blanc. */
export function RouteErrorPage() {
  return (
    <>
      <TopBar />
      <main className="page">
        <p role="alert" className="text-error centered">Une erreur est survenue. Rechargez la page.</p>
      </main>
    </>
  );
}
