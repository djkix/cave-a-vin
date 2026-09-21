import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from 'react-router-dom';
import { ApiError, getMe } from '../lib/api-client';

export function RequireAuth() {
  const me = useQuery({ queryKey: ['me'], queryFn: getMe, retry: false });
  if (me.isPending) return <p className="centered">Chargement…</p>;
  if (me.isError && me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (me.isError) return <p className="centered">Serveur injoignable.</p>;
  return <Outlet />;
}
