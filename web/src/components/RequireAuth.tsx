import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from 'react-router-dom';
import { ApiError, getMe } from '../lib/api-client';

export function RequireAuth() {
  const me = useQuery({ queryKey: ['me'], queryFn: getMe, retry: false });
  if (me.isPending) return <p className="centered">Chargement…</p>;
  // 401 : pas de session. 403 : session valide mais compte bloqué (AuthenticatedGuard) —
  // dans les deux cas, retour à l'écran de connexion plutôt qu'un faux « serveur injoignable ».
  if (me.isError && me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)) {
    return <Navigate to="/login?error=unauthorized" replace />;
  }
  if (me.isError) return <p className="centered">Serveur injoignable.</p>;
  return <Outlet />;
}
