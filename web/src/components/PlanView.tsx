import { MouseEvent, useState } from 'react';
import { type CavePlan, type PlanMarker, planImageUrl } from '../lib/api-client';
import { usePlan } from '../lib/locations';
import { useCurrentCave } from '../lib/use-current-cave';

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Plan de la cave et repères numérotés de ses zones, placés en pourcentage de
 * l'image : justes à toute taille. La place de l'image est réservée au format
 * enregistré (largeur et hauteur) avant son chargement. `onPlanClick(x, y)` :
 * position touchée en fractions de la boîte rendue ; `onMarkerClick` : repère
 * touché. Sans `onMarkerClick`, les repères ne sont pas des boutons. `pending` :
 * repère qui vient d'être posé, pas encore attribué à une zone (mis en avant).
 */
export function PlanView({ src, plan, markers, highlightZoneId, pending, onPlanClick, onMarkerClick, maxWidth, alt = 'Plan de la cave' }: {
  src: string; plan: CavePlan; markers: PlanMarker[]; highlightZoneId?: string | null; pending?: { x: number; y: number } | null;
  onPlanClick?: (x: number, y: number) => void; onMarkerClick?: (zoneId: string) => void; maxWidth?: number; alt?: string;
}) {
  function click(e: MouseEvent<HTMLSpanElement>) {
    if (!onPlanClick) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    onPlanClick(clamp((e.clientX - box.left) / box.width), clamp((e.clientY - box.top) / box.height));
  }
  return (
    // Placement au toucher (souris ou doigt) ; les repères restent des boutons accessibles au clavier.
    // span (affiché en bloc) : le petit plan d'« À boire » vit dans un bouton, qui n'admet pas de div.
    <span className={`plan-view${onPlanClick ? ' plan-view--placing' : ''}`} style={{ aspectRatio: `${plan.width} / ${plan.height}`, maxWidth }} onClick={click}>
      <img className="plan-view__image" src={src} alt={alt} width={plan.width} height={plan.height} decoding="async" />
      {[...markers, ...(pending ? [{ zoneId: '', name: 'Nouveau repère', number: 0, ...pending }] : [])].map((m) => {
        const highlighted = m.zoneId === '' || m.zoneId === highlightZoneId;
        const props = {
          className: `plan-view__marker${highlighted ? ' plan-view__marker--highlight' : ''}`,
          style: { left: `${m.x * 100}%`, top: `${m.y * 100}%` },
          'aria-label': m.zoneId === '' ? m.name : `Zone ${m.number} : ${m.name}`,
          'aria-current': highlighted ? ('true' as const) : undefined,
        };
        return onMarkerClick && m.zoneId !== '' ? (
          <button key={m.zoneId} type="button" {...props} onClick={(e) => { e.stopPropagation(); onMarkerClick(m.zoneId); }}>{m.number}</button>
        ) : (
          <span key={m.zoneId || 'pending'} role="img" {...props}>{m.zoneId === '' ? '+' : m.number}</span>
        );
      })}
    </span>
  );
}

/**
 * Plan de la cave, repère de la zone en avant (fiche du vin, « À boire »),
 * en lecture seule pour tous. À n'afficher que pour une zone qui a un repère
 * (`zone.marker`) : le plan n'est lu qu'alors. Rien sans plan. `mini` : petit
 * plan (160 px) avec ce seul repère, qui s'agrandit au toucher avec tous les repères.
 */
export function ZonePlan({ zoneId, mini }: { zoneId: string; mini?: boolean }) {
  const { caveId } = useCurrentCave();
  const data = usePlan().data;
  const [open, setOpen] = useState(false);
  if (!caveId || !data?.plan || !data.markers.some((m) => m.zoneId === zoneId)) return null;
  const src = planImageUrl(caveId, data.plan.updatedAt);
  if (mini && !open) {
    return (
      <button type="button" className="plan-mini" aria-label="Agrandir le plan" onClick={() => setOpen(true)}>
        <PlanView src={src} plan={data.plan} markers={data.markers.filter((m) => m.zoneId === zoneId)} highlightZoneId={zoneId} maxWidth={160} />
      </button>
    );
  }
  return (
    <div className="plan-chooser">
      <PlanView src={src} plan={data.plan} markers={data.markers} highlightZoneId={zoneId} />
      {mini && <button type="button" className="btn btn--link" onClick={() => setOpen(false)}>Réduire le plan</button>}
    </div>
  );
}
