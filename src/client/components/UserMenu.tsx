import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { UserManagementModal } from './UserManagementModal.js';
import { SharedLinksListModal } from './SharedLinksListModal.js';
import { ApiTokensModal } from './ApiTokensModal.js';
import { SecretAuditModal } from './SecretAuditModal.js';
import { Users, LogOut, ChevronDown, Globe, KeyRound, ShieldAlert } from 'lucide-react';

export function UserMenu() {
  const { user, authEnabled, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [sharesModalOpen, setSharesModalOpen] = useState(false);
  const [tokensModalOpen, setTokensModalOpen] = useState(false);
  const [secretsModalOpen, setSecretsModalOpen] = useState(false);
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
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-card hover:bg-muted border border-border transition-all text-xs text-foreground cursor-pointer"
      >
        <div className="w-5 h-5 rounded-full bg-accent-muted text-accent-muted-foreground flex items-center justify-center font-semibold text-[10px]">
          {initials}
        </div>
        <span className="font-medium max-w-[120px] truncate">{user.displayName}</span>
        {user.role === 'admin' && (
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-accent-muted text-accent-muted-foreground font-medium">
            Admin
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
      </button>

      {menuOpen && (
        <div className="absolute right-0 mt-2 w-56 bg-card border border-border rounded-xl shadow-lg py-1.5 z-50">
          <div className="px-3.5 py-2 border-b border-border mb-1">
            <p className="text-xs font-medium text-foreground truncate">{user.displayName}</p>
            <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
          </div>

          <button
            onClick={() => {
              setMenuOpen(false);
              setSharesModalOpen(true);
            }}
            className="w-full px-3.5 py-2 text-left text-xs text-foreground hover:bg-muted flex items-center gap-2 transition-colors cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-muted-foreground" />
            Liens partagés
          </button>

          <button
            onClick={() => {
              setMenuOpen(false);
              setTokensModalOpen(true);
            }}
            className="w-full px-3.5 py-2 text-left text-xs text-foreground hover:bg-muted flex items-center gap-2 transition-colors cursor-pointer"
          >
            <KeyRound className="w-3.5 h-3.5 text-muted-foreground" />
            Jetons d'appareil
          </button>

          {user.role === 'admin' && (
            <button
              onClick={() => {
                setMenuOpen(false);
                setSecretsModalOpen(true);
              }}
              className="w-full px-3.5 py-2 text-left text-xs text-foreground hover:bg-muted flex items-center gap-2 transition-colors cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground" />
              Secrets dans l'historique
            </button>
          )}

          {user.role === 'admin' && (
            <button
              onClick={() => {
                setMenuOpen(false);
                setUsersModalOpen(true);
              }}
              className="w-full px-3.5 py-2 text-left text-xs text-foreground hover:bg-muted flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Users className="w-3.5 h-3.5 text-muted-foreground" />
              Gérer les utilisateurs
            </button>
          )}

          {authEnabled && (
            <button
              onClick={() => {
                setMenuOpen(false);
                logout();
              }}
              className="w-full px-3.5 py-2 text-left text-xs text-destructive hover:bg-destructive-muted flex items-center gap-2 transition-colors cursor-pointer border-t border-border mt-1"
            >
              <LogOut className="w-3.5 h-3.5" />
              Déconnexion
            </button>
          )}
        </div>
      )}

      <UserManagementModal isOpen={usersModalOpen} onClose={() => setUsersModalOpen(false)} />
      <ApiTokensModal isOpen={tokensModalOpen} onClose={() => setTokensModalOpen(false)} />
      <SecretAuditModal isOpen={secretsModalOpen} onClose={() => setSecretsModalOpen(false)} />
      {sharesModalOpen && <SharedLinksListModal onClose={() => setSharesModalOpen(false)} />}
    </div>
  );
}
