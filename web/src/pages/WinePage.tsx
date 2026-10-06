import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApogeeBlock } from '../components/ApogeeBlock';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { DomaineBlock, producerPollInterval } from '../components/DomaineBlock';
import { PairingBlock, pairingPollInterval } from '../components/PairingBlock';
import { RatingBlock } from '../components/RatingBlock';
import { SortieConfirmation } from '../components/SortieConfirmation';
import { TopBar } from '../components/TopBar';
import { WineThumb } from '../components/WineThumb';
import { ApiError, getWine, postInventory } from '../lib/api-client';

const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const TYPE_LABEL = { IN: 'Entrée', OUT: 'Sortie', ADJUST: 'Correction' } as const;

function plural(n: number) {
  return `${n} bouteille${Math.abs(n) > 1 ? 's' : ''}`;
}

const MAX_COUNTED = 100_000;

export function WinePage() {
  const { wineId = '' } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['wine', wineId],
    queryFn: () => getWine(wineId),
    refetchInterval: (q) => {
      const wine = q.state.data?.wine;
      const pairing = pairingPollInterval(wine?.pairing);
      const producer = producerPollInterval(wine?.producerKey ?? null, wine?.producerProfile);
      return pairing || producer;
    },
  });
  const [counting, setCounting] = useState(false);
  const [counted, setCounted] = useState('');
  const [inventoryMessage, setInventoryMessage] = useState<string | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inventoryKey = useMemo(() => crypto.randomUUID(), [wineId, counting]);

  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <>
        <TopBar title="Fiche vin" back="/cave" />
        <main className="page">
          <p className="centered">{notFound ? 'Vin introuvable' : 'Impossible de charger la fiche.'}</p>
          <Link to="/cave" className="btn btn--outline">Retour à la cave</Link>
        </main>
      </>
    );
  }
  if (!detail.data) return <TopBar title="Fiche vin" back="/cave" />;

  const { wine, movements } = detail.data;
  // Même borne que l'API : au-delà, la colonne INTEGER déborderait.
  const tooMany = /^\d+$/.test(counted) && Number(counted) > MAX_COUNTED;
  const parsed = /^\d+$/.test(counted) && !tooMany ? Number(counted) : null;
  const delta = parsed === null ? null : parsed - wine.quantity;

  async function saveInventory() {
    if (parsed === null || delta === 0) return;
    setSaving(true);
    setInventoryError(null);
    try {
      const r = await postInventory(wine.id, { idempotencyKey: inventoryKey, counted: parsed });
      setInventoryMessage(`Stock corrigé : ${r.stock} en stock`);
      setCounting(false);
      void qc.invalidateQueries({ predicate: (q) => ['cave', 'wine', 'movements'].includes(String(q.queryKey[0])) });
    } catch (e) {
      setInventoryError(e instanceof Error ? e.message : 'Correction impossible');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TopBar title="Fiche vin" back="/cave" />
      <main className="page">
        <section className="card" style={{ display: 'flex', gap: 'var(--space-md)' }}>
          <WineThumb photoId={wine.referencePhotoId} size={96} />
          <div>
            <h2 className="list__title" style={{ fontSize: 20, margin: 0 }}>
              {wine.producer}{wine.cuvee ? ` — ${wine.cuvee}` : ''}
            </h2>
            <p className="list__meta">{wine.appellationRaw} · {wine.vintage ?? 'NV'} · {wine.formatCl} cl</p>
            <p className="num" style={{ fontSize: 22, margin: 0 }}>{wine.quantity} en stock</p>
          </div>
        </section>

        {/* Clé distincte de celle de SortieConfirmation : deux enfants du même
            <main> partageant la même clé troublent la réconciliation de React
            (avertissement « two children with the same key », rendu dupliqué). */}
        <ApogeeBlock key={`apogee-${wine.id}`} wine={wine} />
        <RatingBlock key={`rating-${wine.id}`} wine={wine} />
        <DomaineBlock key={`domaine-${wine.id}`} wineId={wine.id} producerKey={wine.producerKey} producerProfile={wine.producerProfile} />
        <PairingBlock key={`pairing-${wine.id}`} wineId={wine.id} pairing={wine.pairing} />

        <SortieConfirmation key={wine.id} wine={wine} />

        <section className="card">
          {inventoryMessage && <p role="status">{inventoryMessage}</p>}
          {!counting ? (
            <Button variant="outline" onClick={() => { setCounting(true); setCounted(String(wine.quantity)); setInventoryMessage(null); }}>
              Corriger le stock
            </Button>
          ) : (
            <>
              <label className="field__label">
                Bouteilles comptées
                <input inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value.trim())} />
              </label>
              <p>{tooMany ? 'Nombre de bouteilles trop élevé' : delta === null ? 'Saisis un nombre entier' : delta === 0 ? 'Stock déjà juste' : `${delta > 0 ? '+' : '−'}${plural(Math.abs(delta))}`}</p>
              {inventoryError && <p role="alert" className="text-error">{inventoryError}</p>}
              <Button variant="dark" onClick={saveInventory} disabled={saving || delta === null || delta === 0}>Enregistrer l’inventaire</Button>
              <Button variant="link" onClick={() => setCounting(false)}>Abandonner</Button>
            </>
          )}
        </section>

        <h2 style={{ fontSize: 14, letterSpacing: '0.08em', color: 'var(--color-secondary)' }}>DERNIERS MOUVEMENTS</h2>
        <div className="list">
          {movements.map((m) => (
            <div key={m.id} className="list__row">
              <span className={`list__delta ${m.delta > 0 ? 'list__delta--in' : 'list__delta--out'} num`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
              <span className="list__meta">{TYPE_LABEL[m.type]} · {fmt.format(new Date(m.occurredAt))}{m.note ? ` · ${m.note}` : ''}</span>
            </div>
          ))}
        </div>
      </main>
      <BottomNav />
    </>
  );
}
