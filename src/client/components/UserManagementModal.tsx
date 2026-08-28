import React, { useEffect, useState } from 'react';
import type { User, UserRole } from '../../types.js';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.js';
import { X, UserPlus, Trash2, Shield, User as UserIcon, Loader2, Check } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function UserManagementModal({ isOpen, onClose }: Props) {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // New user form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('member');
  const [submitting, setSubmitting] = useState(false);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const list = await api.users();
      setUsers(list);
    } catch (err: any) {
      setError(err.message || 'Impossible de charger les utilisateurs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadUsers();
      setShowAddForm(false);
      setError(null);
      setSuccess(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!newEmail || !newDisplayName || !newPassword) {
      setError('Veuillez remplir tous les champs.');
      return;
    }

    try {
      setSubmitting(true);
      const created = await api.createUser({
        email: newEmail,
        displayName: newDisplayName,
        password: newPassword,
        role: newRole,
      });
      setUsers((prev) => [...prev, created]);
      setSuccess(`Utilisateur ${created.displayName} créé avec succès.`);
      setNewEmail('');
      setNewDisplayName('');
      setNewPassword('');
      setNewRole('member');
      setShowAddForm(false);
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la création');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteUser = async (id: string, name: string) => {
    if (!window.confirm(`Êtes-vous sûr de vouloir supprimer l'utilisateur "${name}" ?`)) return;

    try {
      await api.deleteUser(id);
      setUsers((prev) => prev.filter((u) => u.id !== id));
      setSuccess(`Utilisateur "${name}" supprimé.`);
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la suppression');
    }
  };

  const handleToggleRole = async (targetUser: User) => {
    const nextRole: UserRole = targetUser.role === 'admin' ? 'member' : 'admin';
    try {
      const updated = await api.updateUser(targetUser.id, { role: nextRole });
      setUsers((prev) => prev.map((u) => (u.id === targetUser.id ? updated : u)));
      setSuccess(`Rôle de ${updated.displayName} mis à jour (${nextRole}).`);
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la mise à jour du rôle');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Gestion des Utilisateurs & Accès</h2>
              <p className="text-xs text-slate-400">Gérez les comptes d'accès à l'instance Sync Hub</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Feedback banners */}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-red-950/60 border border-red-800/50 text-red-200 text-xs flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {success && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/50 text-emerald-200 text-xs flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              {success}
            </span>
            <button onClick={() => setSuccess(null)} className="text-emerald-400 hover:text-emerald-200">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Membres enregistrés ({users.length})
            </h3>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 transition-colors cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              {showAddForm ? 'Fermer le formulaire' : 'Nouvel utilisateur'}
            </button>
          </div>

          {/* Add form */}
          {showAddForm && (
            <form onSubmit={handleCreateUser} className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-indigo-400 flex items-center gap-1.5 mb-1">
                <UserPlus className="w-3.5 h-3.5" />
                Ajouter un nouveau membre
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Nom complet</label>
                  <input
                    type="text"
                    required
                    placeholder="Robin Joseph"
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Email</label>
                  <input
                    type="email"
                    required
                    placeholder="robin@ekonum.fr"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Mot de passe provisoire</label>
                  <input
                    type="password"
                    required
                    placeholder="••••••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Rôle</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="member">Membre standard</option>
                    <option value="admin">Administrateur</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Créer le compte
                </button>
              </div>
            </form>
          )}

          {/* Users Table */}
          {loading ? (
            <div className="py-12 flex justify-center text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : (
            <div className="border border-slate-800/80 rounded-xl overflow-hidden bg-slate-950/40">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/60 border-b border-slate-800 text-slate-400 uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="px-4 py-2.5">Utilisateur</th>
                    <th className="px-4 py-2.5">Email</th>
                    <th className="px-4 py-2.5">Rôle</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {users.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-slate-200 flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-[10px]">
                            {u.displayName.slice(0, 2).toUpperCase()}
                          </div>
                          <span>{u.displayName}</span>
                          {isSelf && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                              Vous
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-400">{u.email}</td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => !isSelf && handleToggleRole(u)}
                            disabled={isSelf}
                            title={isSelf ? 'Vous ne pouvez pas modifier votre propre rôle' : 'Cliquer pour changer de rôle'}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-all ${
                              u.role === 'admin'
                                ? 'bg-violet-500/15 text-violet-300 border border-violet-500/30'
                                : 'bg-slate-800 text-slate-300 border border-slate-700'
                            } ${!isSelf ? 'hover:scale-105 cursor-pointer' : 'cursor-default'}`}
                          >
                            {u.role === 'admin' ? <Shield className="w-3 h-3 text-violet-400" /> : <UserIcon className="w-3 h-3" />}
                            {u.role === 'admin' ? 'Admin' : 'Membre'}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!isSelf && (
                            <button
                              onClick={() => handleDeleteUser(u.id, u.displayName)}
                              className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                              title="Supprimer l'utilisateur"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/40 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
