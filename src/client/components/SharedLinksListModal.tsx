import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Trash2, X, Eye, Clock, AlertCircle } from 'lucide-react';
import type { SharedThread } from '../../types.js';
import { api } from '../lib/api.js';

interface SharedLinksListModalProps {
  onClose: () => void;
  onSelectThread?: (threadId: string) => void;
}

type ShareItem = SharedThread & { threadTitle: string; projectName?: string };

export function SharedLinksListModal({ onClose, onSelectThread }: SharedLinksListModalProps) {
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadShares();
  }, []);

  async function loadShares() {
    try {
      setLoading(true);
      const list = await api.allShares();
      setShares(list);
    } catch (err: any) {
      setError(err.message || 'Erreur lors du chargement des partages');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleActive(share: ShareItem) {
    try {
      const updated = await api.updateShare(share.id, { isActive: !share.isActive });
      setShares((prev) => prev.map((s) => (s.id === share.id ? { ...s, ...updated } : s)));
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
        className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl overflow-hidden flex flex-col max-h-[85vh]"
        role="dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-card">
          <div className="flex items-center gap-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-muted text-accent-muted-foreground">
              <Globe size={16} className="text-accent" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Gestion des liens partagés</h2>
              <p className="text-sm text-muted-foreground">
                Toutes les conversations actuellement accessibles via un lien public
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-destructive-muted border border-destructive/20 p-4 text-sm text-destructive">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Chargement des liens partagés…</div>
          ) : shares.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-16 text-center text-sm text-muted-foreground">
              Aucun lien de partage n'a été créé pour le moment.
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
                        : 'border-border bg-card hover:border-border/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => {
                              if (onSelectThread) {
                                onSelectThread(s.threadId);
                                onClose();
                              }
                            }}
                            className="font-medium text-sm text-foreground hover:underline text-left truncate cursor-pointer"
                          >
                            {s.title || s.threadTitle}
                          </button>
                          {s.projectName && (
                            <span className="inline-flex items-center rounded-xl bg-muted px-2 py-2 text-sm text-muted-foreground">
                              {s.projectName}
                            </span>
                          )}
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
