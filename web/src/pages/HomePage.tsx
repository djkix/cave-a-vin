import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BottomNav } from '../components/BottomNav';
import { Icon } from '../components/Icon';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { TopBar } from '../components/TopBar';
import { getRecentMovements } from '../lib/api-client';
import { MovementRow } from './JournalPage';

export function HomePage() {
  const movements = useQuery({ queryKey: ['movements', 'recent'], queryFn: () => getRecentMovements(3) });
  return (
    <>
      <TopBar />
      <main className="page">
        <OfflineQueueBanner />
        <section className="actions">
          <Link to="/entree" className="action action--in">
            <Icon name="qr_code_scanner" />
            <span className="action__text">
              <strong>Rentrer du vin</strong>
              <small>Arrivage de cartons (6, 12, 18) ou bouteilles</small>
            </span>
            <Icon name="arrow_forward" />
          </Link>
          <button type="button" className="action action--out" disabled>
            <Icon name="remove_circle_outline" />
            <span className="action__text">
              <strong>Sortir une bouteille</strong>
              <small>Bientôt disponible (lot 2)</small>
            </span>
          </button>
        </section>
        <Link to="/entree/campagne" className="btn btn--outline">
          Mode campagne (reprise de la cave)
        </Link>
        <h2 style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)' }}>DERNIERS MOUVEMENTS</h2>
        <div className="list">
          {movements.data?.map((m) => <MovementRow key={m.id} m={m} />)}
          {movements.data?.length === 0 && <p className="centered">Aucun mouvement pour l’instant.</p>}
        </div>
        <Link to="/journal" className="btn btn--link">Voir le journal</Link>
      </main>
      <BottomNav />
    </>
  );
}
