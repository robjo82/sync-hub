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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        role="dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-muted/40">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Globe size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Gestion des liens partagés</h2>
              <p className="text-xs text-muted-foreground">
                Toutes les conversations actuellement accessibles via un lien public
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="py-12 text-center text-xs text-muted-foreground">Chargement des liens partagés…</div>
          ) : shares.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-12 text-center text-xs text-muted-foreground">
              Aucun lien de partage n'a été créé pour le moment.
            </div>
          ) : (
            <div className="space-y-3">
              {shares.map((s) => {
                const isExpired = s.expiresAt && new Date(s.expiresAt) <= new Date();
                const shareUrl = `${window.location.origin}/shared/${s.shareToken}`;
                const isCopied = copiedToken === s.shareToken;

                return (
                  <div
                    key={s.id}
                    className={`rounded-lg border p-3.5 transition-colors ${
                      !s.isActive || isExpired
                        ? 'border-border/60 bg-muted/10 opacity-75'
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
                            className="font-medium text-xs text-foreground hover:underline text-left truncate"
                          >
                            {s.title || s.threadTitle}
                          </button>
                          {s.projectName && (
                            <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {s.projectName}
                            </span>
                          )}
                          {!s.isActive ? (
                            <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                              Désactivé
                            </span>
                          ) : isExpired ? (
                            <span className="inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                              Expiré
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                              Actif
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1 flex-wrap">
                          <span className="flex items-center gap-1 font-medium text-foreground">
                            <Eye size={11} /> {s.viewCount} {s.viewCount > 1 ? 'vues' : 'vue'}
                          </span>
                          {s.expiresAt ? (
                            <span className="flex items-center gap-1">
                              <Clock size={11} /> Expire le {new Date(s.expiresAt).toLocaleDateString('fr-FR')}
                            </span>
                          ) : (
                            <span>Permanent</span>
                          )}
                          <span>Créé le {new Date(s.createdAt).toLocaleDateString('fr-FR')}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleToggleActive(s)}
                          className="rounded-md p-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                          title={s.isActive ? 'Désactiver le lien' : 'Réactiver le lien'}
                        >
                          {s.isActive ? 'Désactiver' : 'Activer'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(s.id)}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                          title="Supprimer définitivement"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {/* URL bar with copy & open */}
                    <div className="flex items-center gap-1.5 rounded-md bg-muted/60 border border-border/80 px-2.5 py-1.5">
                      <input
                        type="text"
                        readOnly
                        value={shareUrl}
                        className="w-full bg-transparent text-xs text-muted-foreground focus:outline-none font-mono select-all truncate"
                      />
                      <button
                        type="button"
                        onClick={() => handleCopy(s.shareToken)}
                        className="shrink-0 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-background transition-colors"
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
                        className="shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors"
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
        <div className="border-t border-border px-6 py-3 bg-muted/20 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-background px-4 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
