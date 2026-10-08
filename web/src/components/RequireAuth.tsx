import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ApiError } from '../lib/api-client';
import { useCurrentCave, useMe } from '../lib/use-current-cave';
import { useBackgroundSender } from '../lib/use-background-sender';
import { NoCaveScreen, PendingScreen } from './AccountScreens';

export function RequireAuth() {
  const me = useMe();
  const { isOwner } = useCurrentCave();
  const { pathname } = useLocation();
  // Racine des pages protégées : les photos restées sur le téléphone partent
  // quelle que soit la page ouverte, pas seulement là où le bandeau s'affiche.
  // Un membre en lecture seule ne peut pas en envoyer (403) : rien ne part.
  useBackgroundSender(me.isSuccess && isOwner ? me.data.id : null);
  if (me.isPending) return <p className="centered">Chargement…</p>;
  // 401 : pas de session. 403 : session valide mais compte bloqué (AuthenticatedGuard) —
  // dans les deux cas, retour à l'écran de connexion plutôt qu'un faux « serveur injoignable ».
  if (me.isError && me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)) {
    return <Navigate to="/login?error=unauthorized" replace />;
  }
  if (me.isError) return <p className="centered">Serveur injoignable.</p>;
  if (me.data.status === 'PENDING') return <PendingScreen />;
  if (me.data.caves.length === 0) {
    // L'administration ne dépend d'aucune cave : un administrateur sans cave doit
    // pouvoir y valider des inscriptions, voire se créer la sienne.
    if (me.data.isAdmin && pathname.startsWith('/admin')) return <Outlet />;
    return <NoCaveScreen isAdmin={me.data.isAdmin} />;
  }
  // Clé = cave courante : après un changement de cave, toutes les pages sont
  // remontées (filtres, formulaires, requêtes) au lieu de garder l'état de l'ancienne.
  return <Outlet key={me.data.currentCaveId ?? 'aucune'} />;
}

/**
 * Pages réservées au propriétaire de la cave courante (entrée, sortie, journal,
 * « À confirmer », « Ma cave ») : un membre en lecture seule revient à l'accueil,
 * y compris juste après avoir changé de cave depuis l'une d'elles.
 */
export function RequireOwner() {
  const { me, isOwner } = useCurrentCave();
  if (!me) return null;
  if (!isOwner) return <Navigate to="/" replace />;
  return <Outlet />;
}
