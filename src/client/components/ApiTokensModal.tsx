import React, { useEffect, useState } from 'react';
import { X, KeyRound, Plus, Loader2, Copy, Check, Ban } from 'lucide-react';
import { api, type ApiTokenSummary } from '../lib/api.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Machine tokens: what a sync-hub daemon presents to push to, or pull from, the hub. One per
 * device, so a lost laptop is revoked on its own instead of rotating a secret shared by everyone.
 */
export function ApiTokensModal({ isOpen, onClose }: Props) {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The plaintext exists here and nowhere else, for as long as this modal stays open.
  const [justCreated, setJustCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setTokens(await api.tokens());
    } catch (err: any) {
      setError(err.message || 'Impossible de charger les jetons');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    load();
    setJustCreated(null);
    setError(null);
    setName('');
  }, [isOpen]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!isOpen) return null;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.createToken(name.trim());
      setJustCreated({ name: created.name, token: created.token });
      setName('');
      await load();
    } catch (err: any) {
      setError(err.message || 'Création impossible');
    } finally {
      setSubmitting(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.revokeToken(id);
      await load();
    } catch (err: any) {
      setError(err.message || 'Révocation impossible');
    }
  };

  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-card border border-border rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent-muted flex items-center justify-center">
              <KeyRound className="w-4 h-4 text-accent" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Jetons d'appareil</h2>
              <p className="text-xs text-muted-foreground">Ce que chaque machine présente pour synchroniser</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          {error && (
            <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive-muted px-3 py-2 text-xs text-destructive">{error}</div>
          )}

          {justCreated && (
            <div className="mb-4 rounded-lg border border-accent/30 bg-accent-muted px-3 py-3">
              <p className="text-xs font-medium text-accent-muted-foreground mb-1">Jeton pour « {justCreated.name} »</p>
              <p className="text-[11px] text-muted-foreground mb-2">
                Copie-le maintenant : il n'est plus affiché ensuite, et le serveur n'en garde que l'empreinte.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-card px-2 py-1.5 font-mono text-[11px] text-foreground">{justCreated.token}</code>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(justCreated.token);
                      setCopied(true);
                    } catch {
                      // A clipboard write can fail silently (permissions, insecure context) —
                      // claiming success without confirmation would be worse than saying nothing.
                    }
                  }}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copié' : 'Copier'}
                </button>
              </div>
            </div>
          )}

          <form onSubmit={create} className="mb-4 flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom de la machine — ex. MacBook Robin"
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-foreground disabled:opacity-40 cursor-pointer"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Créer
            </button>
          </form>

          {loading ? (
            <p className="text-xs text-muted-foreground">Chargement…</p>
          ) : active.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Aucun jeton actif. Crée-en un par machine qui doit synchroniser avec ce hub.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {active.map((t) => (
                <li key={t.id} className="flex items-center justify-between px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{t.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Créé le {new Date(t.createdAt).toLocaleDateString('fr-FR')}
                      {t.lastUsedAt
                        ? ` · dernier usage le ${new Date(t.lastUsedAt).toLocaleDateString('fr-FR')}`
                        : ' · jamais utilisé'}
                    </p>
                  </div>
                  <button
                    onClick={() => revoke(t.id)}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-destructive hover:bg-destructive-muted cursor-pointer"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    Révoquer
                  </button>
                </li>
              ))}
            </ul>
          )}

          {revoked.length > 0 && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              {revoked.length} jeton(s) révoqué(s), conservés pour rester identifiables s'ils réapparaissent dans un journal.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
