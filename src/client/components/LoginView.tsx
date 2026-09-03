import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { LogIn, Loader2, Sparkles } from 'lucide-react';

export function LoginView() {
  const { login, googleAvailable, googleDomains } = useAuth();
  // The callback redirects people back here with a reason when the flow fails: a redirect cannot
  // surface a JSON error to a human.
  const redirectError = new URLSearchParams(window.location.search).get('auth_error');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(redirectError);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError('Veuillez saisir votre email et votre mot de passe.');
      return;
    }

    try {
      setSubmitting(true);
      await login(email, password);
    } catch (err: any) {
      setError(err.message || 'Identifiants invalides ou erreur de connexion.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-lg p-10">
        <div className="flex flex-col items-center text-center mb-10">
          <div className="w-12 h-12 rounded-xl bg-accent-muted text-accent-muted-foreground flex items-center justify-center mb-4">
            <Sparkles className="w-6 h-6 text-accent" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Sync Hub</h1>
          <p className="text-sm text-muted-foreground mt-2">Connectez-vous pour accéder à vos historiques IA.</p>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-xl bg-destructive-muted text-destructive border border-destructive/20 text-sm flex items-start gap-2">
            <span className="font-semibold">Erreur :</span>
            <span>{error}</span>
          </div>
        )}

        {googleAvailable && (
          <div className="mb-6">
            <a
              href="/api/auth/google"
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <GoogleMark />
              Se connecter avec Google
            </a>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Réservé aux comptes {googleDomains.join(', ')}
            </p>
            <div className="mt-6 flex items-center gap-4">
              <span className="h-px flex-1 bg-border" />
              <span className="text-sm text-muted-foreground">ou</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Adresse Email
            </label>
            <input
              type="email"
              required
              autoFocus
              placeholder="ex: robin@ekonum.fr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 bg-background border border-border rounded-xl text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Mot de passe
            </label>
            <input
              type="password"
              required
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 bg-background border border-border rounded-xl text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent text-sm"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 py-4 px-4 rounded-xl bg-accent hover:opacity-90 text-accent-foreground font-medium text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-sm"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Connexion en cours…
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  Se connecter
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Google's mark, inline: the CSP on this page allows no external images. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.3 17.6 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.2-.4-4.6H24v9.1h12.4c-.5 2.9-2.2 5.3-4.7 6.9l7.3 5.7c4.3-3.9 6.8-9.8 6.8-17.1z" />
      <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3.1-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C.9 16.3 0 20 0 24s.9 7.7 2.6 10.8l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.4 0-11.7-3.8-13.6-9.1l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
