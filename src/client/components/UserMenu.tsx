import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { UserManagementModal } from './UserManagementModal.js';
import { SharedLinksListModal } from './SharedLinksListModal.js';
import { Users, LogOut, ChevronDown, Globe } from 'lucide-react';

export function UserMenu() {
  const { user, authEnabled, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [sharesModalOpen, setSharesModalOpen] = useState(false);
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
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700/60 hover:border-slate-600 transition-all text-xs text-slate-200 cursor-pointer"
      >
        <div className="w-5 h-5 rounded-full bg-gradient-to-tr from-indigo-500 to-violet-500 text-white flex items-center justify-center font-bold text-[10px] shadow-sm">
          {initials}
        </div>
        <span className="font-medium max-w-[120px] truncate">{user.displayName}</span>
        {user.role === 'admin' && (
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-violet-500/20 text-violet-300 font-medium border border-violet-500/30">
            Admin
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
      </button>

      {menuOpen && (
        <div className="absolute right-0 mt-2 w-56 bg-slate-900 border border-slate-800 rounded-xl shadow-xl py-1.5 z-50 backdrop-blur-lg">
          <div className="px-3.5 py-2 border-b border-slate-800 mb-1">
            <p className="text-xs font-semibold text-white truncate">{user.displayName}</p>
            <p className="text-[11px] text-slate-400 truncate">{user.email}</p>
          </div>

          <button
            onClick={() => {
              setMenuOpen(false);
              setSharesModalOpen(true);
            }}
            className="w-full px-3.5 py-2 text-left text-xs text-slate-200 hover:bg-indigo-600/20 hover:text-indigo-300 flex items-center gap-2 transition-colors cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            Liens partagés
          </button>

          {user.role === 'admin' && (
            <button
              onClick={() => {
                setMenuOpen(false);
                setUsersModalOpen(true);
              }}
              className="w-full px-3.5 py-2 text-left text-xs text-slate-200 hover:bg-indigo-600/20 hover:text-indigo-300 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Users className="w-3.5 h-3.5 text-indigo-400" />
              Gérer les utilisateurs
            </button>
          )}

          {authEnabled && (
            <button
              onClick={() => {
                setMenuOpen(false);
                logout();
              }}
              className="w-full px-3.5 py-2 text-left text-xs text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-colors cursor-pointer border-t border-slate-800/60 mt-1"
            >
              <LogOut className="w-3.5 h-3.5" />
              Déconnexion
            </button>
          )}
        </div>
      )}

      <UserManagementModal isOpen={usersModalOpen} onClose={() => setUsersModalOpen(false)} />
      {sharesModalOpen && <SharedLinksListModal onClose={() => setSharesModalOpen(false)} />}
    </div>
  );
}
