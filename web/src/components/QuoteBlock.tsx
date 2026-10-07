import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createQuote, Quote } from '../lib/api-client';
import {
  CESSION_NOTE, DATE_INVALID, formatEurosRounded, parisToday, parseCoteEuros, parseTransactions, quoteLine, quoteWarnings,
} from '../lib/quote';
import { Button } from './Button';

const MIN_QUOTED_ON = '1990-01-01';
const ERR = { cote: 'quote-cote-error', transactions: 'quote-transactions-error', date: 'quote-date-error' } as const;

/** Message d'erreur d'un champ, relié au champ par `aria-describedby` (l'annonce passe par la région `aria-live` qui l'entoure). */
function FieldError({ id, message }: { id: string; message: string | null }) {
  return message ? <p id={id} className="text-error" style={{ margin: 0 }}>{message}</p> : null;
}

/**
 * Bloc « Cote iDealwine », propriétaire seulement (le parent ne le monte pas
 * pour un membre, qui ne reçoit ni `quote`, ni `idealwineUrl`, ni `savedUrl`).
 * La cote est saisie à la main : l'application ne lit jamais iDealwine, elle
 * n'offre qu'un lien, ouvert dans un nouvel onglet.
 */
export function QuoteBlock({ wineId, quote, idealwineUrl, savedUrl }: {
  wineId: string; quote: Quote | null; idealwineUrl: string; /** Lien enregistré sur une cote, fourni par l'api ; null sans lien. */ savedUrl: string | null;
}) {
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
  // Champ vide : le bouton reste désactivé, sans message tant que rien n'est saisi.
  const coteError = typeof coteCents === 'string' && cote.trim() !== '' ? coteCents : null;
  const transactionsError = typeof nTransactions === 'string' ? nTransactions : null;
  const dateError = quotedOn === '' ? DATE_INVALID : null;
  const invalid = typeof coteCents === 'string' || transactionsError !== null || dateError !== null;

  function open() {
    setCote('');
    setTransactions('');
    setQuotedOn(today);
    setSourceUrl(savedUrl ?? '');
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (typeof coteCents === 'string' || typeof nTransactions === 'string' || quotedOn === '') return;
    setBusy(true);
    setError(null);
    try {
      await createQuote(wineId, { coteCents, nTransactions, quotedOn, sourceUrl: sourceUrl.trim() || null });
      setEditing(false);
      void qc.invalidateQueries({ predicate: (q) => ['wine', 'stats'].includes(String(q.queryKey[0])) });
    } catch (e) {
      // Même règle que les autres blocs de la fiche : le message de l'erreur tel quel.
      setError(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  }

  const fieldA11y = (message: string | null, id: string) => ({ 'aria-invalid': message !== null, 'aria-describedby': message ? id : undefined });

  return (
    <section className="card">
      <h3 style={{ fontSize: 16, margin: 0 }}>Cote iDealwine</h3>
      {!editing && (quote ? (
        <>
          <p style={{ margin: 'var(--space-xs) 0' }}>{quoteLine(quote, today)}</p>
          <p className="list__meta" style={{ margin: 0 }}>
            {`Valeur de cession estimée : ${formatEurosRounded(quote.cessionCents)} ${CESSION_NOTE}`}
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
          <input id="quote-cote" inputMode="decimal" value={cote} onChange={(e) => setCote(e.target.value)} placeholder="85" {...fieldA11y(coteError, ERR.cote)} />
          <div aria-live="polite"><FieldError id={ERR.cote} message={coteError} /></div>
          <label className="field__label" htmlFor="quote-transactions">Nombre de transactions (facultatif)</label>
          <input
            id="quote-transactions" inputMode="numeric" value={transactions} onChange={(e) => setTransactions(e.target.value)}
            {...fieldA11y(transactionsError, ERR.transactions)}
          />
          <div aria-live="polite"><FieldError id={ERR.transactions} message={transactionsError} /></div>
          <label className="field__label" htmlFor="quote-date">Date de la cote</label>
          <input
            id="quote-date" type="date" min={MIN_QUOTED_ON} max={today} value={quotedOn} onChange={(e) => setQuotedOn(e.target.value)}
            {...fieldA11y(dateError, ERR.date)}
          />
          <div aria-live="polite"><FieldError id={ERR.date} message={dateError} /></div>
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
          <a className="btn btn--outline" href={idealwineUrl} target="_blank" rel="noopener noreferrer">
            {quote ? 'Voir sur iDealwine' : 'Voir la cote sur iDealwine'}
            <span className="visually-hidden"> (nouvel onglet)</span>
          </a>
          <Button variant="outline" onClick={open}>{quote ? 'Mettre à jour' : 'Saisir la cote'}</Button>
        </div>
      )}
    </section>
  );
}
