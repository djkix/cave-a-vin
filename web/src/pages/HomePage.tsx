import { Link } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { TopBar } from '../components/TopBar';

export function HomePage() {
  return (
    <>
      <TopBar />
      <main className="page">
        <OfflineQueueBanner />
        <section className="actions">
          <Link to="/entree" className="action action--in">
            <span className="material-symbols-outlined">qr_code_scanner</span>
            <span className="action__text">
              <strong>Rentrer du vin</strong>
              <small>Arrivage de cartons (6, 12, 18) ou bouteilles</small>
            </span>
            <span className="material-symbols-outlined">arrow_forward</span>
          </Link>
          <button type="button" className="action action--out" disabled>
            <span className="material-symbols-outlined">remove_circle_outline</span>
            <span className="action__text">
              <strong>Sortir une bouteille</strong>
              <small>Bientôt disponible (lot 2)</small>
            </span>
          </button>
        </section>
        <Link to="/entree/campagne" className="btn btn--outline">
          Mode campagne (reprise de l'existant)
        </Link>
      </main>
      <BottomNav />
    </>
  );
}
