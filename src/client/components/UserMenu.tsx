import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { LogOut, ChevronDown, UserCog } from 'lucide-react';

export function UserMenu({ onOpenAccount }: { onOpenAccount?: () => void }) {
  const { user, authEnabled, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!user) return null;

  const initials = user.displayName
    ? user.displayName
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'U';

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card hover:bg-muted border border-border transition-all text-sm text-foreground cursor-pointer"
      >
        <div className="w-5 h-5 rounded-full bg-accent-muted text-accent-muted-foreground flex items-center justify-center font-semibold text-sm">
          {initials}
        </div>
        <span className="font-medium max-w-[120px] truncate">{user.displayName}</span>
        {user.role === 'admin' && (
          <span className="text-sm px-2 py-2 rounded-xl bg-accent-muted text-accent-muted-foreground font-medium">
            Admin
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
      </button>

      {menuOpen && (
        <div className="absolute right-0 mt-2 w-56 bg-card border border-border rounded-xl shadow-lg py-2 z-50">
          <div className="px-4 py-2 border-b border-border mb-2">
            <p className="text-sm font-medium text-foreground truncate">{user.displayName}</p>
            <p className="text-sm text-muted-foreground truncate">{user.email}</p>
          </div>

          {/* One way in, instead of four dialogs that each showed a slice of the same account. */}
          <button
            onClick={() => {
              setMenuOpen(false);
              onOpenAccount?.();
            }}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
          >
            <UserCog className="h-4 w-4 text-muted-foreground" />
            Mon compte
          </button>

          {authEnabled && (
            <button
              onClick={() => {
                setMenuOpen(false);
                logout();
              }}
              className="w-full px-4 py-2 text-left text-sm text-destructive hover:bg-destructive-muted flex items-center gap-2 transition-colors cursor-pointer border-t border-border mt-2"
            >
              <LogOut className="w-3.5 h-3.5" />
              Déconnexion
            </button>
          )}
        </div>
      )}

    </div>
  );
}
