import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Link2, Plus, Trash2, X, Clock, Eye, AlertCircle } from 'lucide-react';
import type { SharedThread, Thread } from '../../types.js';
import { api } from '../lib/api.js';

interface ShareModalProps {
  thread: Thread;
  onClose: () => void;
}

const EXPIRY_OPTIONS = [
  { label: 'Jamais (permanent)', value: '' },
  { label: '24 heures', value: '24h' },
  { label: '7 jours', value: '7d' },
  { label: '30 jours', value: '30d' },
  { label: '90 jours', value: '90d' },
];

function calculateExpiryIso(option: string): string | null {
  if (!option) return null;
  const now = Date.now();
  switch (option) {
    case '24h':
      return new Date(now + 24 * 3600 * 1000).toISOString();
    case '7d':
      return new Date(now + 7 * 86400 * 1000).toISOString();
    case '30d':
      return new Date(now + 30 * 86400 * 1000).toISOString();
    case '90d':
      return new Date(now + 90 * 86400 * 1000).toISOString();
    default:
      return null;
  }
}

export function ShareModal({ thread, onClose }: ShareModalProps) {
  const [shares, setShares] = useState<SharedThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [expiryOption, setExpiryOption] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadShares();
  }, [thread.id]);

  async function loadShares() {
    try {
      setLoading(true);
      const list = await api.threadShares(thread.id);
      setShares(list);
    } catch (err: any) {
      setError(err.message || 'Erreur lors du chargement des partages');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      setCreating(true);
      setError(null);
      const expiresAt = calculateExpiryIso(expiryOption);
      const created = await api.createShare(thread.id, {
        title: customTitle.trim() || undefined,
        expiresAt,
      });
      setShares((prev) => [created, ...prev]);
      setCustomTitle('');
      setExpiryOption('');
      // Auto-copy the newly generated link
      handleCopy(created.shareToken);
    } catch (err: any) {
      setError(err.message || 'Impossible de créer le lien de partage');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(share: SharedThread) {
    try {
      const updated = await api.updateShare(share.id, { isActive: !share.isActive });
      setShares((prev) => prev.map((s) => (s.id === share.id ? updated : s)));
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la mise à jour');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Supprimer définitivement ce lien de partage ?')) return;
    try {
      await api.deleteShare(id);
      setShares((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la suppression');
    }
  }

  async function handleCopy(token: string) {
    const url = `${window.location.origin}/shared/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      // Fallback
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className="w-full max-w-xl rounded-xl border border-border bg-card shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
        role="dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-card">
          <div className="flex items-center gap-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-muted text-accent-muted-foreground">
              <Globe size={16} className="text-accent" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Partager cette conversation</h2>
              <p className="text-sm text-muted-foreground truncate max-w-sm">{thread.title}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-destructive-muted border border-destructive/20 p-4 text-sm text-destructive">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Form to create new share */}
          <form onSubmit={handleCreate} className="space-y-4 rounded-xl border border-border bg-muted/40 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Plus size={14} className="text-accent" /> Créer un nouveau lien public
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">Titre personnalisé (optionnel)</label>
                <input
                  type="text"
                  placeholder={thread.title}
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">Durée de validité</label>
                <select
                  value={expiryOption}
                  onChange={(e) => setExpiryOption(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={creating}
                className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50 transition-opacity shadow-sm cursor-pointer"
              >
                <Link2 size={13} />
                {creating ? 'Génération…' : 'Générer le lien public'}
              </button>
            </div>
          </form>

          {/* List of existing shares */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Liens existants ({shares.length})
            </h3>

            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Chargement des liens…</div>
            ) : shares.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Aucun lien de partage créé pour cette conversation.
              </div>
            ) : (
              <div className="space-y-4">
                {shares.map((s) => {
                  const isExpired = s.expiresAt && new Date(s.expiresAt) <= new Date();
                  const shareUrl = `${window.location.origin}/shared/${s.shareToken}`;
                  const isCopied = copiedToken === s.shareToken;

                  return (
                    <div
                      key={s.id}
                      className={`rounded-xl border p-4 transition-colors ${
                        !s.isActive || isExpired
                          ? 'border-border/60 bg-muted/20 opacity-75'
                          : 'border-border bg-card'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm text-foreground truncate">
                              {s.title || thread.title}
                            </span>
                            {!s.isActive ? (
                              <span className="inline-flex items-center rounded-full bg-destructive-muted px-2 py-2 text-sm font-medium text-destructive">
                                Désactivé
                              </span>
                            ) : isExpired ? (
                              <span className="inline-flex items-center rounded-full bg-warning-muted px-2 py-2 text-sm font-medium text-warning-foreground">
                                Expiré
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full bg-success-muted px-2 py-2 text-sm font-medium text-success">
                                Actif
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2 flex-wrap">
                            <span className="flex items-center gap-2 font-medium text-foreground">
                              <Eye size={11} /> {s.viewCount} {s.viewCount > 1 ? 'vues' : 'vue'}
                            </span>
                            {s.expiresAt ? (
                              <span className="flex items-center gap-2">
                                <Clock size={11} /> Expire le {new Date(s.expiresAt).toLocaleDateString('fr-FR')}
                              </span>
                            ) : (
                              <span>Permanent</span>
                            )}
                            <span>Créé le {new Date(s.createdAt).toLocaleDateString('fr-FR')}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleActive(s)}
                            className="rounded-xl px-2 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                            title={s.isActive ? 'Désactiver le lien' : 'Réactiver le lien'}
                          >
                            {s.isActive ? 'Désactiver' : 'Activer'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(s.id)}
                            className="rounded-xl p-2 text-muted-foreground hover:text-destructive hover:bg-destructive-muted transition-colors cursor-pointer"
                            title="Supprimer définitivement"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* URL bar with copy & open */}
                      <div className="flex items-center gap-2 rounded-xl bg-muted/50 border border-border px-4 py-2">
                        <input
                          type="text"
                          readOnly
                          value={shareUrl}
                          className="w-full bg-transparent text-sm text-muted-foreground focus:outline-none font-mono select-all truncate"
                        />
                        <button
                          type="button"
                          onClick={() => handleCopy(s.shareToken)}
                          className="shrink-0 flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-medium text-foreground hover:bg-card transition-colors cursor-pointer"
                          title="Copier l'URL"
                        >
                          {isCopied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                          <span className={isCopied ? 'text-success font-semibold' : ''}>
                            {isCopied ? 'Copié' : 'Copier'}
                          </span>
                        </button>
                        <a
                          href={`/shared/${s.shareToken}`}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 p-2 text-muted-foreground hover:text-foreground transition-colors"
                          title="Ouvrir dans un nouvel onglet"
                        >
                          <ExternalLink size={13} />
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-6 py-4 bg-card flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
