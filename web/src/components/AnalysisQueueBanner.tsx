import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getPhotoQueueStatus } from '../lib/api-client';
import { Icon } from './Icon';

/**
 * Une photo reportée n'apparaît nulle part : la revue groupée ne liste que les
 * analyses terminées, et le journal n'a encore aucun mouvement pour elle. Sans ce
 * bandeau, l'utilisateur croit sa photo perdue et la reprend inutilement.
 *
 * Complément du bandeau hors ligne : celui-ci compte les photos encore sur le
 * téléphone, celui-là les photos déjà reçues par le serveur.
 */
export function AnalysisQueueBanner({ hideLink = false }: { hideLink?: boolean }) {
  const status = useQuery({ queryKey: ['photos', 'queue-status'], queryFn: getPhotoQueueStatus, refetchInterval: 30_000 });
  const waiting = status.data?.waiting ?? 0;
  if (waiting === 0) return null;
  return (
    <aside className="banner" role="status">
      <Icon name="hourglass_top" />
      <span>
        <strong className="num">
          {waiting} photo{waiting > 1 ? 's' : ''} en attente d’analyse
        </strong>
        <br />
        <small>{status.data?.lastReason ?? 'Analyse automatique dès que le service de lecture répond'}</small>
      </span>
      {!hideLink && (
        <Link to="/entree/campagne/revue" className="btn btn--outline">
          Voir la revue
        </Link>
      )}
    </aside>
  );
}
