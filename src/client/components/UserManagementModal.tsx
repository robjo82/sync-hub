import React, { useEffect, useState } from 'react';
import type { User, UserRole } from '../../types.js';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.js';
import { X, UserPlus, Trash2, Shield, User as UserIcon, Loader2, Check } from 'lucide-react';
import { PanelShell } from './PanelShell.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 'panel' renders it as a section of the account screen instead of a floating modal. */
  variant?: 'modal' | 'panel';
}

export function UserManagementModal({ isOpen, onClose, variant = 'modal' }: Props) {
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

  if (!isOpen && variant === 'modal') return null;

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
    <PanelShell
      variant={variant}
      onClose={onClose}
      icon={<Shield className="h-5 w-5" />}
      title="Utilisateurs & accès"
      subtitle="Les comptes autorisés sur cette instance"
    >

        {/* Feedback banners */}
        {error && (
          <div className="mx-6 mt-4 p-4 rounded-xl bg-destructive-muted text-destructive border border-destructive/20 text-sm flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="hover:opacity-70">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {success && (
          <div className="mx-6 mt-4 p-4 rounded-xl bg-success-muted text-success border border-success/20 text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Check className="w-3.5 h-3.5 text-success" />
              {success}
            </span>
            <button onClick={() => setSuccess(null)} className="hover:opacity-70">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Membres enregistrés ({users.length})
            </h3>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl bg-accent-muted text-accent-muted-foreground hover:opacity-90 transition-colors cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              {showAddForm ? 'Fermer le formulaire' : 'Nouvel utilisateur'}
            </button>
          </div>

          {/* Add form */}
          {showAddForm && (
            <form onSubmit={handleCreateUser} className="p-4 rounded-xl bg-muted/40 border border-border space-y-4">
              <div className="text-sm font-semibold text-foreground flex items-center gap-2 mb-2">
                <UserPlus className="w-3.5 h-3.5 text-accent" />
                Ajouter un nouveau membre
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">Nom complet</label>
                  <input
                    type="text"
                    required
                    placeholder="Robin Joseph"
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    className="w-full px-4 py-2 bg-background border border-border rounded-xl text-sm text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">Email</label>
                  <input
                    type="email"
                    required
                    placeholder="robin@ekonum.fr"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="w-full px-4 py-2 bg-background border border-border rounded-xl text-sm text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">Mot de passe provisoire</label>
                  <input
                    type="password"
                    required
                    placeholder="••••••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-4 py-2 bg-background border border-border rounded-xl text-sm text-foreground placeholder-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-2">Rôle</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="w-full px-4 py-2 bg-background border border-border rounded-xl text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="member">Membre standard</option>
                    <option value="admin">Administrateur</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-accent hover:opacity-90 text-accent-foreground font-medium rounded-xl text-sm transition-opacity flex items-center gap-2 disabled:opacity-50 cursor-pointer shadow-sm"
                >
                  {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Créer le compte
                </button>
              </div>
            </form>
          )}

          {/* Users Table */}
          {loading ? (
            <div className="py-16 flex justify-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : (
            <div className="border border-border rounded-xl overflow-hidden bg-card">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted text-muted-foreground uppercase tracking-wider text-sm">
                  <tr>
                    <th className="px-4 py-4">Utilisateur</th>
                    <th className="px-4 py-4">Email</th>
                    <th className="px-4 py-4">Rôle</th>
                    <th className="px-4 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <tr key={u.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-4 font-medium text-foreground flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-accent-muted text-accent-muted-foreground flex items-center justify-center font-semibold text-sm">
                            {u.displayName.slice(0, 2).toUpperCase()}
                          </div>
                          <span>{u.displayName}</span>
                          {isSelf && (
                            <span className="text-sm px-2 py-2 rounded-xl bg-accent-muted text-accent-muted-foreground font-medium">
                              Vous
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-4 text-muted-foreground">{u.email}</td>
                        <td className="px-4 py-4">
                          <button
                            onClick={() => !isSelf && handleToggleRole(u)}
                            disabled={isSelf}
                            title={isSelf ? 'Vous ne pouvez pas modifier votre propre rôle' : 'Cliquer pour changer de rôle'}
                            className={`inline-flex items-center gap-2 px-2 py-2 rounded-full text-sm font-medium transition-all ${
                              u.role === 'admin'
                                ? 'bg-accent-muted text-accent-muted-foreground'
                                : 'bg-muted text-muted-foreground border border-border'
                            } ${!isSelf ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}`}
                          >
                            {u.role === 'admin' ? <Shield className="w-3 h-3 text-accent" /> : <UserIcon className="w-3 h-3" />}
                            {u.role === 'admin' ? 'Admin' : 'Membre'}
                          </button>
                        </td>
                        <td className="px-4 py-4 text-right">
                          {!isSelf && (
                            <button
                              onClick={() => handleDeleteUser(u.id, u.displayName)}
                              className="p-2 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive-muted transition-colors cursor-pointer"
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
        {variant === 'modal' && (
          <div className="px-6 py-4 border-t border-border bg-card flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-xl transition-colors cursor-pointer"
            >
              Fermer
            </button>
          </div>
        )}
    </PanelShell>
  );
}
