import type { ReactNode } from 'react';
import { X } from 'lucide-react';

interface PanelShellProps {
  /** 'modal' floats over the page and can be closed; 'panel' sits inline on the account screen. */
  variant: 'modal' | 'panel';
  title: string;
  subtitle?: string;
  icon: ReactNode;
  onClose?: () => void;
  children: ReactNode;
}

/**
 * The frame shared by the account sections.
 *
 * These started as four separate modals reached from a dropdown — who you are, your devices, what
 * you share, and administration — each with its own header, its own scroll box and its own idea
 * of padding. Nobody could see their account in one place, and each one looked slightly different
 * from the last. The same content now renders either as a modal (where it is still opened on its
 * own) or as a section of the account screen, from one definition.
 */
export function PanelShell({ variant, title, subtitle, icon, onClose, children }: PanelShellProps) {
  const body = (
    <>
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted text-accent">{icon}</div>
          <div>
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {variant === 'modal' && onClose && (
          <button
            onClick={onClose}
            className="cursor-pointer rounded-xl p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {children}
    </>
  );

  if (variant === 'panel') {
    return <section className="overflow-hidden rounded-xl border border-border bg-card">{body}</section>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-xs">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        {body}
      </div>
    </div>
  );
}
