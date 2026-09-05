import React, { useEffect, useState } from 'react';
import { KeyRound, Plus, Loader2, Copy, Check, Ban } from 'lucide-react';
import { PanelShell } from './PanelShell.js';
import { api, type ApiTokenSummary } from '../lib/api.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 'panel' renders it as a section of the account screen instead of a floating modal. */
  variant?: 'modal' | 'panel';
}

/**
 * Machine tokens: what a sync-hub daemon presents to push to, or pull from, the hub. One per
 * device, so a lost laptop is revoked on its own instead of rotating a secret shared by everyone.
 */
export function ApiTokensModal({ isOpen, onClose, variant = 'modal' }: Props) {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The plaintext exists here and nowhere else, for as long as this modal stays open.
  const [justCreated, setJustCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [fingerprint, setFingerprint] = useState('');
  const [approveName, setApproveName] = useState('');
  const [approving, setApproving] = useState(false);

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

  if (!isOpen && variant === 'modal') return null;

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

  const approve = async (e: React.FormEvent) => {
    e.preventDefault();
    setApproving(true);
    setError(null);
    try {
      await api.approveDevice(fingerprint.trim(), approveName.trim());
      setFingerprint('');
      setApproveName('');
      await load();
    } catch (err: any) {
      setError(err.message || 'Approbation impossible');
    } finally {
      setApproving(false);
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
    <PanelShell
      variant={variant}
      onClose={onClose}
      icon={<KeyRound className="h-5 w-5" />}
      title="Jetons d'appareil"
      subtitle="Ce que chaque machine présente pour synchroniser"
    >

        <div className="px-6 py-4 overflow-y-auto">
          {error && (
            <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive-muted px-4 py-2 text-sm text-destructive">{error}</div>
          )}

          {justCreated && (
            <div className="mb-4 rounded-xl border border-accent/30 bg-accent-muted px-4 py-4">
              <p className="text-sm font-medium text-accent-muted-foreground mb-2">Jeton pour « {justCreated.name} »</p>
              <p className="text-sm text-muted-foreground mb-2">
                Copie-le maintenant : il n'est plus affiché ensuite, et le serveur n'en garde que l'empreinte.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-xl bg-card px-2 py-2 font-mono text-sm text-foreground">{justCreated.token}</code>
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
                  className="flex shrink-0 items-center gap-2 rounded-xl border border-border px-2 py-2 text-sm text-muted-foreground hover:bg-muted cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copié' : 'Copier'}
                </button>
              </div>
            </div>
          )}

          {/* La voie recommandée : la machine fabrique son jeton et n'en montre que l'empreinte,
              qui n'autorise rien. Le formulaire ci-dessous, où le hub fabrique le jeton, reste
              disponible mais oblige à faire voyager un secret jusqu'à la machine. */}
          <form onSubmit={approve} className="mb-6 rounded-xl border border-border bg-background/50 p-4">
            <p className="text-sm font-medium text-foreground">Approuver un appareil</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Sur la machine à rattacher : <code className="rounded-xl bg-muted px-2 py-2 font-mono">./scripts/enroll.sh</code>.
              Colle ici l'empreinte qu'il affiche — ce n'est pas un secret.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                value={fingerprint}
                onChange={(e) => setFingerprint(e.target.value)}
                placeholder="Empreinte (64 caractères)"
                className="min-w-0 flex-1 rounded-xl border border-border bg-card px-4 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground"
              />
              <input
                value={approveName}
                onChange={(e) => setApproveName(e.target.value)}
                placeholder="Nom de la machine"
                className="min-w-0 flex-1 rounded-xl border border-border bg-card px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              />
              <button
                type="submit"
                disabled={approving || !fingerprint.trim() || !approveName.trim()}
                className="flex cursor-pointer items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-40"
              >
                {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Approuver
              </button>
            </div>
          </form>

          <p className="mb-2 text-sm text-muted-foreground">
            Ou faire fabriquer le jeton par le hub — il faudra alors le transporter jusqu'à la machine :
          </p>
          <form onSubmit={create} className="mb-4 flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom de la machine — ex. MacBook Robin"
              className="flex-1 rounded-xl border border-border bg-card px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-40 cursor-pointer"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Créer
            </button>
          </form>

          {loading ? (
            <p className="text-sm text-muted-foreground">Chargement…</p>
          ) : active.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun jeton actif. Crée-en un par machine qui doit synchroniser avec ce hub.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {active.map((t) => (
                <li key={t.id} className="flex items-center justify-between px-4 py-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{t.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Créé le {new Date(t.createdAt).toLocaleDateString('fr-FR')}
                      {t.lastUsedAt
                        ? ` · dernier usage le ${new Date(t.lastUsedAt).toLocaleDateString('fr-FR')}`
                        : ' · jamais utilisé'}
                    </p>
                  </div>
                  <button
                    onClick={() => revoke(t.id)}
                    className="flex shrink-0 items-center gap-2 rounded-xl border border-border px-2 py-2 text-sm text-destructive hover:bg-destructive-muted cursor-pointer"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    Révoquer
                  </button>
                </li>
              ))}
            </ul>
          )}

          {revoked.length > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">
              {revoked.length} jeton(s) révoqué(s), conservés pour rester identifiables s'ils réapparaissent dans un journal.
            </p>
          )}
        </div>
    </PanelShell>
  );
}
