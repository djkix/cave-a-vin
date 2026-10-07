import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Me, setCurrentCave } from '../lib/api-client';
import { useCurrentCave } from '../lib/use-current-cave';

// Listes qui valent pour n'importe quelle cave : on y reste après un changement.
const ANY_ROLE = ['/', '/cave', '/stats'];
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
 * Cave courante dans la barre de titre : un sélecteur s'il y en a plusieurs, et
 * le badge « Lecture seule » quand on n'en est que membre.
 */
export function CaveSwitcher() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { caves, caveId, role } = useCurrentCave();
  const change = useMutation({
    mutationFn: (id: string) => setCurrentCave(id),
    onSuccess: async (me: Me) => {
      qc.setQueryData(['me'], me);
      const next = me.caves.find((c) => c.id === me.currentCaveId);
      const target = pathAfterCaveSwitch(pathname, next?.role === 'OWNER');
      if (target !== pathname) navigate(target, { replace: true });
      // Tout ce qui est en cache appartient à l'ancienne cave : on relit tout.
      await qc.invalidateQueries();
    },
  });

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
