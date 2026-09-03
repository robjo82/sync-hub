import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { LogIn, Loader2, Sparkles } from 'lucide-react';

export function LoginView() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
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
