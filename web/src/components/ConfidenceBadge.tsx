export const LOW_CONFIDENCE = 0.7;

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const cls = confidence >= LOW_CONFIDENCE ? 'badge--ok' : 'badge--warn';
  return (
    <span className={`badge ${cls}`} aria-label={`Confiance ${pct} %`}>
      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{confidence >= LOW_CONFIDENCE ? 'verified' : 'help'}</span>
      <span>{pct} %</span>
    </span>
  );
}
