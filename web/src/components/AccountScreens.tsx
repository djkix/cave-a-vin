import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { logout } from '../lib/api-client';
import { APP_VERSION } from '../lib/version';
import { Button } from './Button';
import { Icon } from './Icon';

function LogoutButton() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function run() {
    // Même si l'appel échoue (session déjà expirée), on revient à l'écran de connexion.
    await logout().catch(() => undefined);
    navigate('/login', { replace: true });
    qc.clear();
  }
  return <Button variant="outline" onClick={run}>Se déconnecter</Button>;
}

function AccountScreen({ children }: { children: React.ReactNode }) {
  return (
    <main className="login">
      <Icon name="wine_bar" className="login__logo" />
      <h1 className="login__title">Cave &amp; Terroir</h1>
      {children}
      <LogoutButton />
      {/* Pas de barre de titre ici : la version y est répétée, comme sur l'écran de connexion. */}
      <p className="login__version" aria-label={`Version ${APP_VERSION}`}>v{APP_VERSION}</p>
    </main>
  );
}

/** Compte inscrit, pas encore validé par un administrateur : aucune route ne lui répond. */
export function PendingScreen() {
  return (
    <AccountScreen>
      <p className="centered" role="status">
        Inscription en attente de validation — vous serez prévenu dès qu’un administrateur l’aura validée. Revenez plus tard.
      </p>
    </AccountScreen>
  );
}

/** Compte actif sans aucune cave (ni la sienne, ni une invitation). */
export function NoCaveScreen({ isAdmin }: { isAdmin: boolean }) {
  return (
    <AccountScreen>
      <p className="centered" role="status">
        Vous n’avez pas encore de cave. Un administrateur peut vous en créer une, ou un propriétaire peut vous inviter.
      </p>
      {isAdmin && <Link to="/admin" className="btn btn--primary">Administration</Link>}
    </AccountScreen>
  );
}
