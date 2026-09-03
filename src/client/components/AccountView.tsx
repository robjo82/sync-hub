import { useEffect, useState } from 'react';
import { Cloud, Keyboard, Laptop, Mail, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../lib/api.js';
import { ApiTokensModal } from './ApiTokensModal.js';
import { SharedLinksListModal } from './SharedLinksListModal.js';
import { UserManagementModal } from './UserManagementModal.js';
import { SecretAuditModal } from './SecretAuditModal.js';

/**
 * Everything about "me" on one screen.
 *
 * This used to be four modals behind a dropdown — devices, shared links, users, secret audit —
 * so seeing the state of your own account meant opening and closing four dialogs and holding the
 * answer in your head. Each section keeps its own component; only the frame is shared.
 *
 * The sections shown depend on where you are: device tokens and enrolment are a local machine's
 * business, users and public links are the hub's. Showing all of it everywhere is what made the
 * two instances indistinguishable.
 */
/** Up to two initials, matching the header avatar rather than a lone first letter. */
function initialsOf(displayName?: string, email?: string): string {
  const source = displayName?.trim() || email?.split('@')[0] || '?';
  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function AccountView({ onSelectThread }: { onSelectThread?: (threadId: string) => void }) {
  const { user } = useAuth();
  const [isLocal, setIsLocal] = useState(true);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);

  useEffect(() => {
    api
      .syncStatus()
      .then((st) => {
        setIsLocal(st.localIngest !== false);
        setRemoteUrl(st.remoteUrl);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Compte</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Qui tu es, tes appareils, et ce que tu partages.
        </p>
      </div>

      {/* Identity — small, but it is the thing the screen is named after, and it was nowhere. */}
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-base font-semibold leading-none text-accent-foreground">
            {initialsOf(user?.displayName, user?.email)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-medium text-foreground">{user?.displayName ?? 'Utilisateur local'}</p>
            <p className="flex items-center gap-2 truncate text-sm text-muted-foreground">
              <Mail className="h-4 w-4 shrink-0" />
              {user?.email ?? 'Aucun compte — instance locale sans authentification'}
            </p>
          </div>
          <div className="flex-1" />
          <div className="flex flex-col items-end gap-2">
            {user?.role === 'admin' && (
              <span className="rounded-xl bg-accent-muted px-4 py-2 text-sm font-medium text-accent-muted-foreground">
                Administrateur
              </span>
            )}
            <span className="flex items-center gap-2 whitespace-nowrap rounded-xl bg-muted px-4 py-2 text-sm text-muted-foreground">
              {isLocal ? <Laptop className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
              {isLocal ? 'Cet appareil' : 'Hub partagé'}
            </span>
          </div>
        </div>
        {isLocal && (
          <p className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
            {remoteUrl ? (
              <>
                Cette machine pousse ses conversations vers <span className="text-foreground">{remoteUrl}</span>.
              </>
            ) : (
              "Cette machine n'est reliée à aucun hub : tes conversations restent ici et ne sont pas sauvegardées ailleurs."
            )}
          </p>
        )}
      </section>

      {/* The typing pace the composition estimate rests on. Belongs to the person, not to the
          installation: it is their hands being measured, and lowering it under-bills rather than
          over-bills, which is the safer direction for an invoice. */}
      <TypingPacePanel />

      {/* Device tokens live on the hub: you create one there, then paste it into the machine you
          are enrolling. A local instance holds none of its own, so listing them there showed an
          empty list and told you to create one — in the one place where that does nothing. */}
      {!isLocal && <ApiTokensModal isOpen onClose={() => {}} variant="panel" />}

      <SharedLinksListModal onClose={() => {}} onSelectThread={onSelectThread} variant="panel" />

      {user?.role === 'admin' && <UserManagementModal isOpen onClose={() => {}} variant="panel" />}

      {user?.role === 'admin' && (
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted text-accent">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">Secrets dans l'historique</h2>
              <p className="text-sm text-muted-foreground">
                Chercher des clés et mots de passe dans le verbatim, et les retirer ici et sur le hub.
              </p>
            </div>
            <div className="flex-1" />
            <SecretAuditLauncher />
          </div>
        </section>
      )}
    </div>
  );
}

/** Kept as a dialog: it is a long-running scan with its own state, not a list to glance at. */
function SecretAuditLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 cursor-pointer whitespace-nowrap rounded-xl border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
      >
        Lancer une analyse
      </button>
      <SecretAuditModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Sets the keystrokes-per-minute the "Temps passé" estimate is computed from. */
function TypingPacePanel() {
  const [pace, setPace] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .activity()
      .then((s) => setPace(s.keystrokesPerMinute))
      .catch(() => {});
  }, []);

  const save = async (value: number) => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await api.setTypingPace(value);
      setPace(res.keystrokesPerMinute);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-accent">
          <Keyboard className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Rythme de frappe</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Sert à estimer le temps de rédaction dans <span className="text-foreground">Temps passé</span>. Un rythme
            bas sous-estime plutôt qu'il ne surestime — le bon sens pour une facture. Le temps compté ne dépasse
            jamais le temps réellement écoulé entre deux messages.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <input
              type="number"
              min={5}
              max={600}
              value={pace ?? ''}
              onChange={(e) => setPace(e.target.value ? Number(e.target.value) : null)}
              className="w-28 rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">frappes / minute</span>
            <button
              onClick={() => pace && save(pace)}
              disabled={saving || !pace}
              className="cursor-pointer rounded-xl border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            {saved && <span className="text-sm text-success">Enregistré</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
