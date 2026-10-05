import { Link } from 'react-router-dom';

export interface BarRow { key: string; label: string; bottles: number; share: number; color?: string; to?: string }

const pct = (share: number) => `${Math.round(share * 100)} %`;

/** Barres horizontales : libellé, nombre, part ; une ligne peut mener ailleurs. */
export function BarList({ title, rows }: { title: string; rows: BarRow[] }) {
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>{title}</h2>
      <ul className="bars">
        {rows.map((r) => {
          const body = (
            <>
              <span className="bars__text">
                <span>{r.label}</span>
                <span className="num">{`${r.bottles} · ${pct(r.share)}`}</span>
              </span>
              <span className="bars__track" aria-hidden="true">
                <span className="bars__fill" style={{ width: `${r.share * 100}%`, background: r.color }} />
              </span>
            </>
          );
          return (
            <li key={r.key}>
              {r.to ? <Link to={r.to} className="bars__row">{body}</Link> : <span className="bars__row">{body}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
