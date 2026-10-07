import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AnalysisQueueBanner } from '../components/AnalysisQueueBanner';
import { BottomNav } from '../components/BottomNav';
import { Icon } from '../components/Icon';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { TopBar } from '../components/TopBar';
import { getEntryInbox, getRecentMovements } from '../lib/api-client';
import { useCurrentCave } from '../lib/use-current-cave';
import { MovementRow } from './JournalPage';

export function HomePage() {
  // Journal, photos à confirmer : réservés au propriétaire (403 pour un membre),
  // donc ni requête ni sondage tant que le rôle courant n'est pas OWNER.
  const { isOwner, isAdmin, role } = useCurrentCave();
  const movements = useQuery({ queryKey: ['movements', 'recent'], queryFn: () => getRecentMovements(3), enabled: isOwner });
  // Fiches à valider et photos illisibles : tout ce qui attend une décision.
  const inbox = useQuery({ queryKey: ['entry-inbox'], queryFn: getEntryInbox, refetchInterval: 30_000, enabled: isOwner });
  const toConfirm = isOwner ? (inbox.data?.toConfirm.length ?? 0) + (inbox.data?.failed.length ?? 0) : 0;
  return (
    <>
      <TopBar />
      <main className="page">
        {/* Photos d'un autre compte sur ce téléphone : signalées à tous, envoyées par leur seul auteur. */}
        <OfflineQueueBanner readOnly={!isOwner} />
        {isOwner && (
          <>
            <AnalysisQueueBanner />
            <section className="actions">
              <Link to="/entree" className="action action--in">
                <Icon name="qr_code_scanner" />
                <span className="action__text">
                  <strong>Rentrer du vin</strong>
                  <small>Arrivage de cartons (6, 12, 18) ou bouteilles</small>
                </span>
                <Icon name="arrow_forward" />
              </Link>
              <Link to="/sortie" className="action action--out">
                <Icon name="remove_circle_outline" />
                <span className="action__text">
                  <strong>Sortir une bouteille</strong>
                  <small>Photo de l’étiquette, ou recherche dans la cave</small>
                </span>
                <Icon name="arrow_forward" />
              </Link>
            </section>
            {toConfirm > 0 && (
              <Link to="/a-confirmer" className="btn btn--outline">
                <Icon name="fact_check" />
                <span className="num">{toConfirm}</span> vin{toConfirm > 1 ? 's' : ''} à confirmer
              </Link>
            )}
            <h2 style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)' }}>DERNIERS MOUVEMENTS</h2>
            <div className="list">
              {movements.data?.map((m) => <MovementRow key={m.id} m={m} />)}
              {movements.data?.length === 0 && <p className="centered">Aucun mouvement pour l’instant.</p>}
            </div>
            <Link to="/journal" className="btn btn--link">Voir le journal</Link>
            <Link to="/membres" className="btn btn--link">Membres de la cave</Link>
          </>
        )}
        {role === 'VIEWER' && (
          <section className="actions">
            <Link to="/cave" className="action action--in">
              <Icon name="shelves" />
              <span className="action__text">
                <strong>Voir la cave</strong>
                <small>Fiches, apogées, accords mets-vins</small>
              </span>
              <Icon name="arrow_forward" />
            </Link>
            <Link to="/stats" className="action action--out">
              <Icon name="bar_chart" />
              <span className="action__text">
                <strong>Statistiques</strong>
                <small>Couleurs, régions, millésimes</small>
              </span>
              <Icon name="arrow_forward" />
            </Link>
          </section>
        )}
        {isAdmin && <Link to="/admin" className="btn btn--link">Administration</Link>}
      </main>
      <BottomNav />
    </>
  );
}
