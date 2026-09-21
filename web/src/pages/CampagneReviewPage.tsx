import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { LOW_CONFIDENCE } from '../components/ConfidenceBadge';
import { EditableField } from '../components/EditableField';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { QuantityPicker } from '../components/QuantityPicker';
import { TopBar } from '../components/TopBar';
import { BulkResult, createMovementsBulk, getPendingReviewPhotos, PhotoDto, WineDraft } from '../lib/api-client';
import { extractionToDraft } from '../lib/extraction-to-draft';

interface Row {
  photoId: string;
  idempotencyKey: string;
  draft: WineDraft;
  confidences: Partial<Record<keyof WineDraft, number>>;
  globalConfidence: number;
  quantity: number;
  detected: number | null;
  ignored: boolean;
}

function toRow(p: PhotoDto): Row | null {
  if (!p.extraction) return null;
  const { draft, confidences, detectedQuantity } = extractionToDraft(p.extraction);
  return { photoId: p.id, idempotencyKey: crypto.randomUUID(), draft, confidences, globalConfidence: p.extraction.globalConfidence, quantity: detectedQuantity ?? 1, detected: detectedQuantity, ignored: false };
}

function rowProblem(r: Row): string | null {
  if (!r.draft.producer.trim()) return 'Producteur requis';
  if (!r.draft.appellationRaw.trim()) return 'Appellation requise';
  if (r.draft.vintage != null && (r.draft.vintage < 1900 || r.draft.vintage > new Date().getFullYear())) {
    return `Millésime entre 1900 et ${new Date().getFullYear()}`;
  }
  return null;
}

export function CampagneReviewPage() {
  const photos = useQuery({ queryKey: ['pending-review'], queryFn: getPendingReviewPhotos, refetchInterval: 15_000 });
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!photos.data) return;
    setRows((prev) => {
      const known = new Map(prev.map((r) => [r.photoId, r]));
      return photos.data
        .map((p) => known.get(p.id) ?? toRow(p))
        .filter((r): r is Row => r !== null)
        .sort((a, b) => a.globalConfidence - b.globalConfidence);
    });
  }, [photos.data]);

  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.photoId === id ? { ...r, ...patch } : r)));
  const kept = rows.filter((r) => !r.ignored && rowProblem(r) === null);
  const incomplete = rows.filter((r) => !r.ignored && rowProblem(r) !== null).length;

  async function validate() {
    setBusy(true);
    setSubmitError(null);
    setItemErrors({});
    try {
      const res = await createMovementsBulk(
        kept.map((r) => ({ idempotencyKey: r.idempotencyKey, photoId: r.photoId, wine: { ...r.draft, cuvee: r.draft.cuvee || null, vintage: r.draft.vintage ?? null }, quantity: r.quantity })),
      );
      setResult(res);
      const okKeys = new Set(res.filter((x) => x.ok).map((x) => x.idempotencyKey));
      const errors: Record<string, string> = {};
      res.forEach((x) => {
        if (!x.ok) errors[x.idempotencyKey] = x.error;
      });
      setItemErrors(errors);
      setRows((rs) => rs.filter((r) => !okKeys.has(r.idempotencyKey)));
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Validation impossible');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Revue groupée" back="/entree/campagne" />
      <main className="page" style={{ paddingBottom: 'calc(var(--size-bottomnav-height) + var(--size-action-height) + var(--space-lg))' }}>
        <OfflineQueueBanner />
        {result && (
          <p role="status" className={`badge ${result.some((x) => x.ok) ? 'badge--ok' : 'badge--warn'}`}>
            {result.filter((x) => x.ok).length} fiche{result.filter((x) => x.ok).length > 1 ? 's' : ''} validée{result.filter((x) => x.ok).length > 1 ? 's' : ''}
            {result.some((x) => !x.ok) && ` · ${result.filter((x) => !x.ok).length} en erreur`}
          </p>
        )}
        {photos.isError && <p role="alert" className="text-error">Impossible de charger les fiches à revoir.</p>}
        {photos.isPending && <p className="centered">Chargement…</p>}
        {rows.length === 0 && !photos.isPending && !photos.isError && <p className="centered">Aucune fiche à revoir. Les photos en cours d’analyse apparaîtront ici.</p>}
        {rows.map((r) => {
          const problem = rowProblem(r);
          const itemError = itemErrors[r.idempotencyKey];
          return (
            <article key={r.photoId} className="card" style={{ opacity: r.ignored ? 0.5 : 1 }}>
              <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center' }}>
                <img src={`/api/photos/${r.photoId}/image`} alt="" width={64} height={80} loading="lazy" decoding="async" style={{ objectFit: 'cover', borderRadius: 'var(--radius-md)' }} />
                <span className={`badge ${r.globalConfidence >= LOW_CONFIDENCE ? 'badge--ok' : 'badge--warn'}`}>confiance {Math.round(r.globalConfidence * 100)} %</span>
                {!r.ignored && problem && <span className="badge badge--warn">{problem}</span>}
                {itemError && <span className="badge badge--warn">{itemError}</span>}
                <Button variant="link" onClick={() => update(r.photoId, { ignored: !r.ignored })}>{r.ignored ? 'Reprendre' : 'Ignorer'}</Button>
              </div>
              {!r.ignored && (
                <>
                  <EditableField label="Producteur" serif value={r.draft.producer} confidence={r.confidences.producer} onChange={(v) => update(r.photoId, { draft: { ...r.draft, producer: v } })} />
                  <EditableField label="Cuvée" serif value={r.draft.cuvee ?? ''} confidence={r.confidences.cuvee} onChange={(v) => update(r.photoId, { draft: { ...r.draft, cuvee: v } })} />
                  <EditableField label="Appellation" serif value={r.draft.appellationRaw} confidence={r.confidences.appellationRaw} onChange={(v) => update(r.photoId, { draft: { ...r.draft, appellationRaw: v } })} />
                  <EditableField label="Millésime" type="number" value={r.draft.vintage?.toString() ?? ''} confidence={r.confidences.vintage} onChange={(v) => update(r.photoId, { draft: { ...r.draft, vintage: v ? Number(v) : null } })} />
                  <QuantityPicker value={r.quantity} detected={r.detected} onChange={(n) => update(r.photoId, { quantity: n })} />
                </>
              )}
            </article>
          );
        })}
        {submitError && <p role="alert" className="text-error">{submitError}</p>}
        {rows.length > 0 && (
          <div className="dock">
            <Button variant="dark" onClick={validate} disabled={busy || kept.length === 0}>
              Valider {kept.length} fiche{kept.length > 1 ? 's' : ''}
            </Button>
            <span className="dock__hint">
              Un mouvement IN par fiche · les fiches ignorées restent à revoir
              {incomplete > 0 && ` · ${incomplete} fiche${incomplete > 1 ? 's' : ''} incomplète${incomplete > 1 ? 's' : ''} à corriger ou à ignorer`}
            </span>
          </div>
        )}
      </main>
    </>
  );
}
