import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createQuote, Quote } from '../lib/api-client';
import { formatEurosRounded, isSearchUrl, parisToday, parseCoteEuros, parseTransactions, quoteLine, quoteWarnings } from '../lib/quote';
import { Button } from './Button';

const MIN_QUOTED_ON = '1990-01-01';

/**
 * Bloc « Cote iDealwine », propriétaire seulement (le parent ne le monte pas
 * pour un membre, qui ne reçoit ni `quote` ni `idealwineUrl`). La cote est
 * saisie à la main : l'application ne lit jamais iDealwine, elle n'offre qu'un
 * lien, ouvert dans un nouvel onglet.
 */
export function QuoteBlock({ wineId, quote, idealwineUrl }: { wineId: string; quote: Quote | null; idealwineUrl: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [cote, setCote] = useState('');
  const [transactions, setTransactions] = useState('');
  const [quotedOn, setQuotedOn] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = parisToday();
  const coteCents = parseCoteEuros(cote);
  const nTransactions = parseTransactions(transactions);
  const invalid = typeof coteCents === 'string' || typeof nTransactions === 'string';

  function open() {
    setCote('');
    setTransactions('');
    setQuotedOn(today);
    // Lien enregistré (de la cote courante ou d'une plus ancienne) ; la recherche calculée n'est pas un lien enregistré.
    setSourceUrl(quote?.sourceUrl ?? (quote && !isSearchUrl(idealwineUrl) ? idealwineUrl : ''));
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (typeof coteCents === 'string' || typeof nTransactions === 'string') return;
    setBusy(true);
    setError(null);
    try {
      await createQuote(wineId, { coteCents, nTransactions, quotedOn, sourceUrl: sourceUrl.trim() || null });
      setEditing(false);
      void qc.invalidateQueries({ predicate: (q) => ['wine', 'stats'].includes(String(q.queryKey[0])) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  }

  const link = (label: string) => (
    <a className="btn btn--outline" href={idealwineUrl} target="_blank" rel="noopener noreferrer">{label}</a>
  );

  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>Cote iDealwine</h3>
      {!editing && (quote ? (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>{quoteLine(quote, today)}</p>
          <p className="list__meta" style={{ margin: 0 }}>
            {`Valeur de cession estimée : ${formatEurosRounded(quote.cessionCents)} (cote moins 16 % de frais acheteur)`}
          </p>
          {quoteWarnings(quote, today).map((w) => (
            <p key={w} style={{ margin: 'var(--space-xs) 0 0' }}><span className="badge badge--warn">{w}</span></p>
          ))}
        </>
      ) : (
        <p className="list__meta" style={{ margin: 'var(--space-xs) 0' }}>Pas encore de cote</p>
      ))}
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
          <label className="field__label" htmlFor="quote-cote">Cote en euros</label>
          <input id="quote-cote" inputMode="decimal" value={cote} onChange={(e) => setCote(e.target.value)} placeholder="85" />
          {typeof coteCents === 'string' && cote.trim() !== '' && <p className="text-error" style={{ margin: 0 }}>{coteCents}</p>}
          <label className="field__label" htmlFor="quote-transactions">Nombre de transactions (facultatif)</label>
          <input id="quote-transactions" inputMode="numeric" value={transactions} onChange={(e) => setTransactions(e.target.value)} />
          {typeof nTransactions === 'string' && <p className="text-error" style={{ margin: 0 }}>{nTransactions}</p>}
          <label className="field__label" htmlFor="quote-date">Date de la cote</label>
          <input id="quote-date" type="date" min={MIN_QUOTED_ON} max={today} value={quotedOn} onChange={(e) => setQuotedOn(e.target.value)} />
          <label className="field__label" htmlFor="quote-url">Lien de la page iDealwine (facultatif)</label>
          <input
            id="quote-url" type="url" inputMode="url" autoComplete="off" value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://www.idealwine.com/…"
          />
          {error && <p role="alert" className="text-error" style={{ margin: 0 }}>{error}</p>}
          <Button variant="dark" disabled={busy || invalid} onClick={save}>Enregistrer la cote</Button>
          <Button variant="link" onClick={() => { setEditing(false); setError(null); }}>Abandonner</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
          {link(quote ? 'Voir sur iDealwine' : 'Voir la cote sur iDealwine')}
          <Button variant="outline" onClick={open}>{quote ? 'Mettre à jour' : 'Saisir la cote'}</Button>
        </div>
      )}
    </section>
  );
}
