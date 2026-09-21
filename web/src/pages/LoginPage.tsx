import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { localLogin } from '../lib/api-client';

// Messages posés par l'api quand le retour Google échoue (OAuthRedirectFilter,
// `?error=session`) : la navigation revient ici, il faut dire pourquoi.
const REDIRECT_ERRORS: Record<string, string> = {
  // OAuthRedirectFilter renvoie ce code pour tout ForbiddenException/UnauthorizedException
  // côté connexion Google, y compris un compte bloqué depuis l'espace d'administration.
  unauthorized: 'Connexion refusée. Si votre compte a été bloqué, contactez l’administrateur.',
  session: 'La session n’a pas pu être créée. Réessayez.',
};

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showLocal, setShowLocal] = useState(false);
  const redirectError = REDIRECT_ERRORS[params.get('error') ?? ''] ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await localLogin(email, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connexion impossible');
    }
  }

  return (
    <main className="login">
      <Icon name="wine_bar" className="login__logo" />
      <h1 className="login__title">Cave &amp; Terroir</h1>
      {redirectError && <p role="alert" className="text-error">{redirectError}</p>}
      <a className="btn btn--primary" href="/api/auth/google">
        Se connecter avec Google
      </a>
      <button type="button" className="btn btn--link" onClick={() => setShowLocal((v) => !v)}>
        Compte de secours
      </button>
      {showLocal && (
        <form onSubmit={submit} className="login__form">
          <label>
            E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Mot de passe
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p role="alert" className="text-error">{error}</p>}
          <button type="submit" className="btn btn--dark">Connexion</button>
        </form>
      )}
    </main>
  );
}
