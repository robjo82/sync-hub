import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { ShieldCheck, ArrowRight, Loader2, Sparkles } from 'lucide-react';

export function SetupView() {
  const { setup } = useAuth();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !displayName || !password) {
      setError('Veuillez remplir tous les champs obligatoires.');
      return;
    }

    if (!email.includes('@')) {
      setError('Veuillez saisir une adresse email valide.');
      return;
    }

    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }

    try {
      setSubmitting(true);
      await setup(email, displayName, password);
    } catch (err: any) {
      setError(err.message || 'Une erreur est survenue lors de la configuration.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl shadow-lg p-8">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-accent-muted text-accent-muted-foreground flex items-center justify-center mb-3">
            <Sparkles className="w-6 h-6 text-accent" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Bienvenue sur Sync Hub</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Créez votre compte <strong>Administrateur</strong> racine pour sécuriser et gérer vos conversations d'IA.
          </p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-destructive-muted text-destructive border border-destructive/20 text-xs flex items-start gap-2">
            <span className="font-semibold">Erreur :</span>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Nom complet ou pseudo
            </label>
            <input
              type="text"
              required
              autoFocus
              placeholder="ex: Robin Joseph"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Adresse Email
            </label>
            <input
              type="email"
              required
              placeholder="ex: robin@ekonum.fr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Mot de passe (8 caractères min.)
            </label>
            <input
              type="password"
              required
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Confirmer le mot de passe
            </label>
            <input
              type="password"
              required
              placeholder="••••••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent text-sm"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-accent hover:opacity-90 text-accent-foreground font-medium text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-sm"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Initialisation en cours…
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  Créer le compte Administrateur
                  <ArrowRight className="w-4 h-4 ml-1" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
