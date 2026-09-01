import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert, X } from 'lucide-react';
import type { SecretScanResult } from '../../types.js';
import { api } from '../lib/api.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Credential audit of the stored conversations.
 *
 * sync-hub keeps everything verbatim, which is the point and also the risk: a key pasted into a
 * prompt or printed by a script is archived, indexed, and pushed to the hub. Findings are shown
 * masked and never acted on automatically — removing a false positive would destroy real
 * conversation, which is worse than the leak it was meant to fix.
 */
export function SecretAuditModal({ isOpen, onClose }: Props) {
  const [results, setResults] = useState<SecretScanResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redacting, setRedacting] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [scanned, setScanned] = useState(0);

  // A full pass is minutes of CPU on a real corpus, so the server runs it as a job and we poll.
  const scan = async () => {
    setResults(null);
    setError(null);
    try {
      for (;;) {
        const job = await api.scanSecrets();
        setScanned(job.scanned);
        if (job.status === 'done') {
          setResults(job.results);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err: any) {
      setError(err?.message?.includes('403') ? 'Accès administrateur requis.' : "L'analyse a échoué.");
    }
  };

  const rescan = async () => {
    await api.restartSecretScan();
    await scan();
  };

  useEffect(() => {
    if (isOpen) {
      scan();
      setDone(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const redact = async (r: SecretScanResult) => {
    // The scan never returns the plaintext, so removal needs the value pasted back deliberately.
    // That friction is the safeguard on an irreversible edit to verbatim history.
    const value = window.prompt(
      `Retirer ce secret de ${r.occurrences} endroit(s) ?\n\n${r.kind} — ${r.masked}\n\n` +
        `Colle la valeur complète pour confirmer. L'opération est irréversible ; le hub garde sa propre copie tant qu'il n'a pas resynchronisé.`,
    );
    if (!value) return;
    setRedacting(r.masked);
    setError(null);
    try {
      const res = await api.redactSecret(value.trim());
      setDone(`${res.occurrences} occurrence(s) retirée(s) dans ${res.messagesChanged} message(s).`);
      await scan();
    } catch {
      setError("Valeur incorrecte, ou rien ne correspond. Rien n'a été modifié.");
    } finally {
      setRedacting(null);
    }
  };

  const certain = results?.filter((r) => r.confidence === 'certain') ?? [];
  const probable = results?.filter((r) => r.confidence === 'probable') ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-xs">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning-muted">
              <ShieldAlert className="h-4 w-4 text-warning" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Secrets dans l'historique</h2>
              <p className="text-xs text-muted-foreground">Clés et jetons archivés dans les conversations</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {results !== null && (
              <button
                onClick={rescan}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                Relancer l'analyse
              </button>
            )}
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-4">
          {error && <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive-muted px-3 py-2 text-xs text-destructive">{error}</div>}
          {done && <div className="mb-3 rounded-lg border border-success/30 bg-success-muted px-3 py-2 text-xs text-success">{done}</div>}

          {results === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Analyse de l'historique… {scanned > 0 && `${scanned.toLocaleString('fr-FR')} messages parcourus`}
            </p>
          ) : results.length === 0 ? (
            <p className="text-xs text-muted-foreground">Aucun secret détecté dans l'historique.</p>
          ) : (
            <>
              <Section
                title={`Détections certaines — ${certain.length}`}
                hint="Préfixes reconnus (OpenAI, GitHub, AWS…). Il s'agit presque toujours de vraies clés."
                items={certain}
                onRedact={redact}
                redacting={redacting}
              />
              <Section
                title={`À vérifier — ${probable.length}`}
                hint="Détectées par leur forme. Relis le contexte : certaines sont du code qui nomme un secret sans le contenir."
                items={probable}
                onRedact={redact}
                redacting={redacting}
              />
            </>
          )}
        </div>

        <div className="flex items-start gap-2 border-t border-border px-6 py-3 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            Retirer un secret modifie l'historique de façon irréversible et ne révoque rien : fais-le tourner
            chez son émetteur. Les autres appareils et le hub gardent leur copie jusqu'à leur prochaine synchro.
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  items,
  onRedact,
  redacting,
}: {
  title: string;
  hint: string;
  items: SecretScanResult[];
  onRedact: (r: SecretScanResult) => void;
  redacting: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      <p className="mb-2 text-[11px] text-muted-foreground">{hint}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((r) => (
          <li key={`${r.kind}-${r.masked}`} className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {r.kind} · <code className="font-mono">{r.masked}</code>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {r.occurrences} occurrence(s) · champ {r.field}
                </p>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">{r.sample}</p>
              </div>
              <button
                onClick={() => onRedact(r)}
                disabled={redacting !== null}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-destructive hover:bg-destructive-muted disabled:opacity-40"
              >
                {redacting === r.masked ? 'Retrait…' : 'Retirer'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
