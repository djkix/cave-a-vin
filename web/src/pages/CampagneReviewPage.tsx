import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
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

export function CampagneReviewPage() {
  const photos = useQuery({ queryKey: ['pending-review'], queryFn: getPendingReviewPhotos, refetchInterval: 15_000 });
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<BulkResult | null>(null);
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
  const kept = rows.filter((r) => !r.ignored && r.draft.producer && r.draft.appellationRaw);

  async function validate() {
    setBusy(true);
    try {
      const res = await createMovementsBulk(
        kept.map((r) => ({ idempotencyKey: r.idempotencyKey, photoId: r.photoId, wine: { ...r.draft, cuvee: r.draft.cuvee || null, vintage: r.draft.vintage ?? null }, quantity: r.quantity })),
      );
      setResult(res);
      const okKeys = new Set(res.filter((x) => x.ok).map((x) => x.idempotencyKey));
      setRows((rs) => rs.filter((r) => !okKeys.has(r.idempotencyKey)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Revue groupée" back="/entree/campagne" />
      <main className="page" style={{ paddingBottom: 140 }}>
        <OfflineQueueBanner />
        {result && (
          <p role="status" className="badge badge--ok">
            {result.filter((x) => x.ok).length} fiche{result.filter((x) => x.ok).length > 1 ? 's' : ''} validée{result.filter((x) => x.ok).length > 1 ? 's' : ''}
            {result.some((x) => !x.ok) && ` · ${result.filter((x) => !x.ok).length} en erreur`}
          </p>
        )}
        {photos.isPending && <p className="centered">Chargement…</p>}
        {rows.length === 0 && !photos.isPending && <p className="centered">Aucune fiche à revoir. Les photos en cours d’analyse apparaîtront ici.</p>}
        {rows.map((r) => (
          <article key={r.photoId} className="card" style={{ opacity: r.ignored ? 0.5 : 1 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <img src={`/api/photos/${r.photoId}/image`} alt="" width={64} height={80} style={{ objectFit: 'cover', borderRadius: 8 }} />
              <span className={`badge ${r.globalConfidence >= 0.7 ? 'badge--ok' : 'badge--warn'}`}>confiance {Math.round(r.globalConfidence * 100)} %</span>
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
        ))}
        {rows.length > 0 && (
          <div className="dock">
            <Button variant="dark" onClick={validate} disabled={busy || kept.length === 0}>
              Valider {kept.length} fiche{kept.length > 1 ? 's' : ''}
            </Button>
            <span className="dock__hint">Un mouvement IN par fiche · les fiches ignorées restent à revoir</span>
          </div>
        )}
      </main>
    </>
  );
}
