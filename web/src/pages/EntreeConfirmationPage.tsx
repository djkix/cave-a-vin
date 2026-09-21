import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { EditableField } from '../components/EditableField';
import { Icon } from '../components/Icon';
import { QuantityPicker } from '../components/QuantityPicker';
import { TopBar } from '../components/TopBar';
import { createMovement, getPhoto, MovementResult, PhotoEvent, WineDraft, WineExtraction } from '../lib/api-client';
import { extractionToDraft } from '../lib/extraction-to-draft';
import { subscribePhotoEvents } from '../lib/sse';

const COLORS = [
  { value: 'ROUGE', label: 'Rouge' }, { value: 'BLANC', label: 'Blanc' }, { value: 'ROSE', label: 'Rosé' }, { value: 'PETILLANT', label: 'Pétillant' },
];

const EMPTY: WineDraft = { producer: '', cuvee: '', appellationRaw: '', vintage: null, color: 'ROUGE', formatCl: 75 };

// Un message d'erreur de Gemini ou de la base peut faire plusieurs lignes : la carte
// d'échec n'en montre que le début, le reste n'apporte rien sur un téléphone.
const MAX_ERROR_CHARS = 160;
function shortError(message: string): string {
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

/**
 * Au-delà de ce délai, l'analyse est réputée reportée : la photo est enregistrée
 * côté serveur et sera reprise automatiquement, donc rien ne justifie de garder
 * quelqu'un devant un écran d'attente. Vingt secondes laissent passer une lecture
 * normale (deux à cinq secondes) sans faire patienter pendant une panne.
 */
const DEFER_NOTICE_MS = 20_000;

export function EntreeConfirmationPage() {
  const { photoId = '' } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<PhotoEvent['status']>('PENDING');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<WineExtraction | null>(null);
  const [manual, setManual] = useState(false);
  const [late, setLate] = useState(false);
  const [draft, setDraft] = useState<WineDraft>(EMPTY);
  const [confidences, setConfidences] = useState<Partial<Record<keyof WineDraft, number>>>({});
  const [quantity, setQuantity] = useState(1);
  const [detected, setDetected] = useState<number | null>(null);
  const [price, setPrice] = useState('');
  const [result, setResult] = useState<MovementResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One key per photo, not per value read inside the callback: a fresh photoId must get a fresh key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [photoId]);

  useEffect(() => {
    let cancelled = false;
    let unsub = () => {};
    void getPhoto(photoId)
      .then((p) => {
        if (cancelled) return;
        setStatus(p.status);
        setErrorMessage(p.errorMessage ?? null);
        if (p.status === 'FAILED') return;
        unsub = subscribePhotoEvents(
          photoId,
          (e) => {
            if (cancelled) return;
            setStatus(e.status);
            setErrorMessage(e.errorMessage ?? null);
            if (e.extraction) setExtraction(e.extraction);
          },
          // Flux SSE coupé (réseau, redémarrage de l'api) : l'analyse continue
          // côté serveur, seule la notification est perdue. On bascule donc sur
          // l'écran de report, qui dit la vérité — la photo est en file — plutôt
          // que d'annoncer un échec de lecture.
          () => {
            if (cancelled) return;
            setLate(true);
            setErrorMessage('Connexion au serveur interrompue — l’analyse se poursuit côté serveur.');
          },
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus('FAILED');
        setErrorMessage(e instanceof Error ? e.message : 'Photo introuvable');
      });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [photoId]);

  // Minuteur posé une fois par photo, et non à chaque changement d'état : le
  // passage PENDING → PROCESSING ne doit pas relancer le compte à rebours.
  useEffect(() => {
    setLate(false);
    const timer = setTimeout(() => setLate(true), DEFER_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [photoId]);

  useEffect(() => {
    if (!extraction) return;
    const { draft: d, confidences: c, detectedQuantity } = extractionToDraft(extraction);
    setDraft(d);
    setConfidences(c);
    setDetected(detectedQuantity);
    if (detectedQuantity) setQuantity(detectedQuantity);
  }, [extraction]);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await createMovement({
        idempotencyKey,
        photoId,
        wine: { ...draft, cuvee: draft.cuvee || null, vintage: draft.vintage ?? null },
        quantity,
        priceUnitCents: price ? Math.round(Number(price.replace(',', '.')) * 100) : null,
      });
      setResult(r);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Écriture impossible');
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <>
        <TopBar title="Entrée enregistrée" />
        <main className="page">
          <section className="card">
            <h2>{result.wine.producer}</h2>
            <p className="num">+{result.movement.delta} bouteille{result.movement.delta > 1 ? 's' : ''} · Stock : {result.stock}</p>
          </section>
          <Button variant="dark" onClick={() => navigate('/entree')}>Rentrer un autre vin</Button>
          <Button variant="outline" onClick={() => navigate('/')}>Retour à l’accueil</Button>
        </main>
      </>
    );
  }

  const pending = status === 'PENDING' || status === 'PROCESSING';
  // Report annoncé soit parce que le worker l'a écrit sur la photo (un 503 de
  // Gemini remet la photo en PENDING avec son motif), soit parce que l'attente
  // dépasse DEFER_NOTICE_MS. Dans les deux cas la photo est enregistrée et sera
  // reprise : l'écran le dit et libère l'utilisateur.
  const deferred = !manual && pending && (late || errorMessage !== null);
  const waiting = !manual && pending && !deferred;
  const failed = !manual && status === 'FAILED';

  return (
    <>
      <TopBar title="Nouvelle entrée" back="/entree" />
      <main className="page" style={{ paddingBottom: 'calc(var(--size-bottomnav-height) + var(--size-action-height) + var(--space-lg))' }}>
        <img className="preview" src={`/api/photos/${photoId}/image`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        {waiting && (
          <section className="card">
            <p>Analyse de l’étiquette en cours…</p>
            <div className="progress"><span /></div>
          </section>
        )}
        {deferred && (
          <section className="card" role="status">
            <p style={{ margin: 0, fontWeight: 600 }}>Analyse reportée</p>
            <p style={{ margin: 'var(--space-xs) 0 var(--space-md)' }}>
              {errorMessage ?? 'Le service de lecture d’étiquette est momentanément occupé.'}
              <br />
              <small>
                Ta photo est enregistrée sur le serveur. Elle sera analysée automatiquement dès que le service répond, puis tu la
                valideras dans la revue groupée — rien n’est perdu si tu quittes cet écran.
              </small>
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
              <Button variant="dark" onClick={() => navigate('/')}>
                <Icon name="check_circle" />
                Terminer, j’attends l’analyse
              </Button>
              <Button variant="outline" onClick={() => setManual(true)}>Saisir à la main</Button>
            </div>
          </section>
        )}
        {failed && (
          <section className="card" role="alert">
            <p className="text-error" style={{ margin: 0 }}>Lecture impossible</p>
            <p style={{ margin: 'var(--space-xs) 0 var(--space-md)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortError(errorMessage ?? 'erreur inconnue')}
            </p>
            <Button variant="outline" onClick={() => setManual(true)}>Saisir à la main</Button>
          </section>
        )}
        {(status === 'DONE' || manual) && (
          <>
            <section className="card">
              <EditableField label="Producteur" serif value={draft.producer} confidence={confidences.producer} onChange={(v) => setDraft({ ...draft, producer: v })} />
              <EditableField label="Cuvée" serif value={draft.cuvee ?? ''} confidence={confidences.cuvee} onChange={(v) => setDraft({ ...draft, cuvee: v })} />
              <EditableField label="Appellation" serif value={draft.appellationRaw} confidence={confidences.appellationRaw} onChange={(v) => setDraft({ ...draft, appellationRaw: v })} />
              <EditableField label="Millésime" type="number" value={draft.vintage?.toString() ?? ''} confidence={confidences.vintage} onChange={(v) => setDraft({ ...draft, vintage: v ? Number(v) : null })} />
              <EditableField label="Couleur" value={draft.color} confidence={confidences.color} options={COLORS} onChange={(v) => setDraft({ ...draft, color: v as WineDraft['color'] })} />
              <EditableField label="Format (cl)" type="number" value={String(draft.formatCl)} confidence={confidences.formatCl} onChange={(v) => setDraft({ ...draft, formatCl: Number(v) || 75 })} />
            </section>
            <QuantityPicker value={quantity} detected={detected} onChange={setQuantity} />
            <details className="card">
              <summary>Détails optionnels</summary>
              <EditableField label="Prix d’achat unitaire (€)" type="number" value={price} onChange={setPrice} />
            </details>
            {submitError && <p role="alert" className="text-error">{submitError}</p>}
            <div className="dock">
              <Button variant="dark" onClick={confirm} disabled={submitting || !draft.producer || !draft.appellationRaw}>
                <Icon name="check_circle" />
                {submitting ? 'Enregistrement…' : `Confirmer l’entrée (+${quantity} bouteille${quantity > 1 ? 's' : ''})`}
              </Button>
              <span className="dock__hint">Écrit un mouvement IN · annulable depuis le journal</span>
            </div>
          </>
        )}
      </main>
    </>
  );
}
