import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { localLogin } from '../lib/api-client';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showLocal, setShowLocal] = useState(false);

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
      <span className="material-symbols-outlined login__logo">wine_bar</span>
      <h1 className="login__title">Cave &amp; Terroir</h1>
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
