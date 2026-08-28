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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-8 backdrop-blur-xl">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/30 mb-4">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Sync Hub</h1>
          <p className="text-sm text-slate-400 mt-2">Connectez-vous pour accéder à vos historiques IA.</p>
        </div>

        {error && (
          <div className="mb-6 p-3.5 rounded-xl bg-red-950/60 border border-red-800/50 text-red-200 text-sm flex items-start gap-2">
            <span className="font-semibold text-red-400">Erreur :</span>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Adresse Email
            </label>
            <input
              type="email"
              required
              autoFocus
              placeholder="ex: robin@ekonum.fr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-950/60 border border-slate-800 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Mot de passe
            </label>
            <input
              type="password"
              required
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-950/60 border border-slate-800 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-sm"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 text-white font-medium text-sm shadow-lg shadow-indigo-500/25 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Connexion en cours...
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
