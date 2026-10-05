import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { LOW_CONFIDENCE } from '../components/ConfidenceBadge';
import { EditableField } from '../components/EditableField';
import { OfflineQueueBanner } from '../components/OfflineQueueBanner';
import { QuantityPicker } from '../components/QuantityPicker';
import { TopBar } from '../components/TopBar';
import { ApiError, BulkResult, createMovementsBulk, dismissPhoto, getEntryInbox, PhotoDto, WineDraft } from '../lib/api-client';
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

const sectionTitle = { fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)', textTransform: 'uppercase' } as const;

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

function Thumb({ photoId }: { photoId: string }) {
  return <img src={`/api/photos/${photoId}/image`} alt="" width={64} height={80} loading="lazy" decoding="async" style={{ objectFit: 'cover', borderRadius: 'var(--radius-md)', flexShrink: 0 }} />;
}

/**
 * Liste des photos d'entrée en attente d'une décision : fiches lues à valider,
 * photos encore en analyse, photos illisibles à saisir à la main. Remplace la
 * revue groupée de l’ancien mode campagne.
 */
export function AConfirmerPage() {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: ['entry-inbox'], queryFn: getEntryInbox, refetchInterval: 10_000 });
  const [rows, setRows] = useState<Row[]>([]);
  // Photos validées ou écartées pendant cette visite : une réponse de
  // rafraîchissement partie avant la validation ne doit pas les faire revenir
  // (avec une nouvelle clé d'idempotence, elles seraient validables deux fois).
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<BulkResult | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inbox.data) return;
    const toConfirm = inbox.data.toConfirm;
    setRows((prev) => {
      // Fusion par photo : une fiche en cours de correction garde ses modifications.
      const known = new Map(prev.map((r) => [r.photoId, r]));
      return toConfirm
        .filter((p) => !handled.has(p.id))
        .map((p) => known.get(p.id) ?? toRow(p))
        .filter((r): r is Row => r !== null)
        .sort((a, b) => a.globalConfidence - b.globalConfidence);
    });
  }, [inbox.data, handled]);

  const markHandled = (ids: string[]) => {
    setHandled((h) => new Set([...h, ...ids]));
    setRows((rs) => rs.filter((r) => !ids.includes(r.photoId)));
  };

  const refreshAfterChange = () => {
    for (const queryKey of [['entry-inbox'], ['cave'], ['movements'], ['stats']]) void qc.invalidateQueries({ queryKey });
  };

  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.photoId === id ? { ...r, ...patch } : r)));
  const kept = rows.filter((r) => !r.ignored && rowProblem(r) === null);
  const incomplete = rows.filter((r) => !r.ignored && rowProblem(r) !== null).length;
  const inProgress = (inbox.data?.inProgress ?? []).filter((p) => !handled.has(p.id));
  // Une photo lue mais dont l'extraction est illisible n'a pas de fiche à
  // pré-remplir : elle rejoint « Lecture impossible » plutôt que de disparaître.
  const unreadable = (inbox.data?.toConfirm ?? []).filter((p) => !p.extraction);
  const failed = [...(inbox.data?.failed ?? []), ...unreadable].filter((p) => !handled.has(p.id));

  async function validate(selection: Row[]) {
    setBusy(true);
    setError(null);
    setItemErrors({});
    try {
      const res = await createMovementsBulk(
        selection.map((r) => ({ idempotencyKey: r.idempotencyKey, photoId: r.photoId, wine: { ...r.draft, cuvee: r.draft.cuvee || null, vintage: r.draft.vintage ?? null }, quantity: r.quantity })),
      );
      setResult(res);
      const okKeys = new Set(res.filter((x) => x.ok).map((x) => x.idempotencyKey));
      const errors: Record<string, string> = {};
      res.forEach((x) => {
        if (!x.ok) errors[x.idempotencyKey] = x.error;
      });
      setItemErrors(errors);
      if (okKeys.size > 0) {
        markHandled(selection.filter((r) => okKeys.has(r.idempotencyKey)).map((r) => r.photoId));
        refreshAfterChange();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Validation impossible');
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(photoId: string) {
    setBusy(true);
    setError(null);
    try {
      await dismissPhoto(photoId);
      markHandled([photoId]);
      refreshAfterChange();
    } catch (e) {
      // 404 : la photo n'existe plus, il n'y a plus rien à écarter.
      if (e instanceof ApiError && e.status === 404) {
        markHandled([photoId]);
        refreshAfterChange();
      } else {
        setError(e instanceof Error ? e.message : 'Impossible d’écarter cette photo');
      }
    } finally {
      setBusy(false);
    }
  }

  const okCount = result?.filter((x) => x.ok).length ?? 0;
  const koCount = result ? result.length - okCount : 0;
  const empty = rows.length === 0 && inProgress.length === 0 && failed.length === 0;

  return (
    <>
      <TopBar title="À confirmer" back="/" />
      <main className="page" style={{ paddingBottom: 'calc(var(--size-bottomnav-height) + var(--size-action-height) + var(--space-lg))' }}>
        <OfflineQueueBanner />
        {result && (
          <p role="status" className={`badge ${okCount > 0 ? 'badge--ok' : 'badge--warn'}`}>
            {okCount} fiche{okCount > 1 ? 's' : ''} validée{okCount > 1 ? 's' : ''}
            {koCount > 0 && ` · ${koCount} en erreur`}
          </p>
        )}
        {error && <p role="alert" className="text-error">{error}</p>}
        {inbox.isError && <p role="alert" className="text-error">Impossible de charger les vins à confirmer.</p>}
        {inbox.isPending && <p className="centered">Chargement…</p>}
        {inbox.isSuccess && empty && (
          <p className="centered">Aucun vin à confirmer. Les photos prises en rafale apparaîtront ici une fois analysées.</p>
        )}

        {rows.length > 0 && (
          <section aria-labelledby="a-valider">
            <h2 id="a-valider" style={sectionTitle}>À valider ({rows.length})</h2>
            {rows.map((r) => {
              const problem = rowProblem(r);
              const itemError = itemErrors[r.idempotencyKey];
              return (
                <article key={r.photoId} className="card" style={{ opacity: r.ignored ? 0.5 : 1 }}>
                  <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Thumb photoId={r.photoId} />
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
                  <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'flex-end' }}>
                    <Button variant="outline" onClick={() => dismiss(r.photoId)} disabled={busy}>Écarter</Button>
                    {!r.ignored && (
                      <Button variant="primary" onClick={() => validate([r])} disabled={busy || problem !== null}>Valider</Button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {inProgress.length > 0 && (
          <section aria-labelledby="en-cours">
            <h2 id="en-cours" style={sectionTitle}>En cours d’analyse ({inProgress.length})</h2>
            <ul className="list" style={{ listStyle: 'none', padding: 0 }}>
              {inProgress.map((p) => (
                <li key={p.id} className="card" style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center' }}>
                  <Thumb photoId={p.id} />
                  <span>{p.errorMessage || 'Analyse en cours (environ 1 min)'}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {failed.length > 0 && (
          <section aria-labelledby="illisibles">
            <h2 id="illisibles" style={sectionTitle}>Lecture impossible ({failed.length})</h2>
            <ul className="list" style={{ listStyle: 'none', padding: 0 }}>
              {failed.map((p) => (
                <li key={p.id} className="card" style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Thumb photoId={p.id} />
                  <span style={{ flex: 1, minWidth: 0 }}>{p.errorMessage || 'Étiquette non lue'}</span>
                  <Link to={`/entree/${p.id}`} className="btn btn--outline">Saisir à la main</Link>
                  <Button variant="link" onClick={() => dismiss(p.id)} disabled={busy}>Écarter</Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {rows.length > 0 && (
          <div className="dock">
            <Button variant="dark" onClick={() => validate(kept)} disabled={busy || kept.length === 0}>
              Tout valider ({kept.length})
            </Button>
            <span className="dock__hint">
              Un mouvement d’entrée par fiche · les fiches ignorées restent à confirmer
              {incomplete > 0 && ` · ${plural(incomplete, 'fiche')} incomplète${incomplete > 1 ? 's' : ''} à corriger ou à ignorer`}
            </span>
          </div>
        )}
      </main>
    </>
  );
}
