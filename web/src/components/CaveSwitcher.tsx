import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Me, setCurrentCave } from '../lib/api-client';
import { useCurrentCave } from '../lib/use-current-cave';

// Listes qui valent pour n'importe quelle cave : on y reste après un changement.
const ANY_ROLE = ['/', '/cave', '/stats', '/compte'];
const OWNER_ONLY = ['/entree', '/sortie', '/journal', '/a-confirmer', '/membres'];

/**
 * Où rester après un changement de cave : une liste encore permise au nouveau
 * rôle est gardée ; une page réservée devenue interdite, ou une page d'un vin ou
 * d'une photo de l'ancienne cave (introuvable dans la nouvelle), ramène à l'accueil.
 */
export function pathAfterCaveSwitch(pathname: string, isOwner: boolean): string {
  if (ANY_ROLE.includes(pathname) || pathname.startsWith('/admin')) return pathname;
  if (isOwner && OWNER_ONLY.includes(pathname)) return pathname;
  return '/';
}

/**
 * Changer de cave courante : vide le cache de l'ancienne cave et, si la page
 * n'est plus permise au nouveau rôle, revient à l'accueil.
 */
export function useSwitchCave() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useMutation({
    mutationFn: (id: string) => setCurrentCave(id),
    onSuccess: async (me: Me) => {
      // Tout ce qui est en cache appartient à l'ancienne cave. Ni « relire »
      // (l'ancien contenu resterait affiché pendant le chargement), ni relancer
      // sous la nouvelle session une requête que le nouveau rôle n'autorise
      // plus : on arrête et on retire tout sauf la session, sans aucune
      // relance. Les observateurs encore montés ne sont pas prévenus d'un
      // retrait : rien ne repart avant le nouveau rendu.
      const stale = { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== 'me' };
      await qc.cancelQueries(stale);
      qc.removeQueries(stale);
      // La session est posée avant la navigation : aucune image ne montre la
      // nouvelle page sous l'ancienne cave ni l'ancienne page sous la nouvelle.
      // RequireAuth remonte les pages (clé = cave courante), dont les requêtes
      // repartent de zéro avec le nouveau rôle — seules celles qu'il autorise
      // sont lancées.
      qc.setQueryData(['me'], me);
      const next = me.caves.find((c) => c.id === me.currentCaveId);
      const target = pathAfterCaveSwitch(pathname, next?.role === 'OWNER');
      if (target !== pathname) navigate(target, { replace: true });
    },
  });
}

/**
 * Cave courante dans la barre de titre : un sélecteur s'il y en a plusieurs, et
 * le badge « Lecture seule » quand on n'en est que membre.
 */
export function CaveSwitcher() {
  const { caves, caveId, role } = useCurrentCave();
  const change = useSwitchCave();

  if (caves.length === 0) return null;
  const readOnly = role === 'VIEWER';
  if (caves.length < 2 && !readOnly) return null;

  return (
    <div className="topbar__cave">
      {caves.length > 1 && (
        <select
          aria-label="Cave"
          className="topbar__select"
          value={caveId ?? ''}
          disabled={change.isPending}
          onChange={(e) => change.mutate(e.target.value)}
        >
          {caves.map((c) => (
            <option key={c.id} value={c.id}>{c.role === 'VIEWER' ? `${c.name} (lecture)` : c.name}</option>
          ))}
        </select>
      )}
      {readOnly && <span className="badge badge--warn topbar__badge">Lecture seule</span>}
      {change.isError && <span role="alert" className="topbar__error">{(change.error as Error).message}</span>}
    </div>
  );
}
