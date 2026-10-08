import { Link } from 'react-router-dom';
import { LogoutButton } from '../components/AccountScreens';
import { BottomNav } from '../components/BottomNav';
import { Button } from '../components/Button';
import { useSwitchCave } from '../components/CaveSwitcher';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { exportUrl } from '../lib/api-client';
import { useInstallPrompt } from '../lib/install-prompt';
import { useCurrentCave } from '../lib/use-current-cave';
import { APP_VERSION } from '../lib/version';

function InstallCard() {
  const { state, install } = useInstallPrompt();
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Application sur le téléphone</h2>
      {state === 'installed' && <p>L’application est installée sur cet appareil.</p>}
      {state === 'prompt' && (
        <Button variant="primary" onClick={install}>
          <Icon name="install_mobile" />
          Installer l’application
        </Button>
      )}
      {state === 'ios' && (
        <p>Dans Safari, touchez <strong>Partager</strong>, puis <strong>Sur l’écran d’accueil</strong>.</p>
      )}
      {state === 'manual' && (
        <p>Ouvrez le menu du navigateur, puis <strong>Installer l’application</strong> ou <strong>Ajouter à l’écran d’accueil</strong>.</p>
      )}
    </section>
  );
}

function CavesCard() {
  const { caves, caveId } = useCurrentCave();
  const change = useSwitchCave();
  if (caves.length === 0) return null;
  return (
    <section className="card">
      <h2 style={{ fontSize: 18 }}>Mes caves</h2>
      <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {caves.map((c) => (
          <li key={c.id} className="list__row" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', justifyContent: 'space-between' }}>
            <span>
              {c.name}
              <span className="list__meta" style={{ display: 'block' }}>{c.role === 'OWNER' ? 'Propriétaire' : 'Invité, lecture seule'}</span>
            </span>
            {c.id === caveId ? (
              <span className="badge">Cave affichée</span>
            ) : (
              <Button variant="outline" disabled={change.isPending} onClick={() => change.mutate(c.id)}>Afficher</Button>
            )}
          </li>
        ))}
      </ul>
      {change.isError && <p role="alert" className="text-error">{(change.error as Error).message}</p>}
    </section>
  );
}

/** Mon compte : installation, caves, sauvegarde, version, déconnexion. Ouvert à tout compte connecté. */
export function ComptePage() {
  const { isOwner, isAdmin, me } = useCurrentCave();
  return (
    <>
      <TopBar title="Mon compte" back="/" />
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        {me && <p className="list__meta">{me.displayName ?? me.email}</p>}
        <InstallCard />
        <CavesCard />
        {isOwner && (
          <section className="card">
            <h2 style={{ fontSize: 18 }}>Sauvegarde</h2>
            <p className="list__meta">Toute la cave affichée dans un classeur Excel : stock, journal, cotes.</p>
            <a className="btn btn--primary" style={{ width: '100%' }} href={exportUrl()} download>
              <Icon name="download" />
              Télécharger la sauvegarde Excel
            </a>
          </section>
        )}
        {isAdmin && <Link to="/admin" className="btn btn--link">Administration</Link>}
        <p className="list__meta" aria-label={`Version ${APP_VERSION}`}>Version {APP_VERSION}</p>
        <LogoutButton />
      </main>
      <BottomNav />
    </>
  );
}
