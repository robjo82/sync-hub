import React, { createContext, useContext, useEffect, useState } from 'react';
import type { User } from '../../types.js';
import { api } from '../lib/api.js';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  authEnabled: boolean;
  setupRequired: boolean;
  googleAvailable: boolean;
  googleDomains: string[];
  login: (email: string, password: string) => Promise<void>;
  setup: (email: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [googleDomains, setGoogleDomains] = useState<string[]>([]);

  const checkStatus = async () => {
    try {
      setLoading(true);
      const status = await api.authStatus();
      setAuthEnabled(status.authEnabled);
      setSetupRequired(status.setupRequired);
      setGoogleAvailable(status.googleAvailable === true);
      setGoogleDomains(status.googleDomains ?? []);
      setUser(status.user);
    } catch (err) {
      console.error('Failed to check auth status:', err);
      // Fallback
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkStatus();
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.login({ email, password });
    setUser(res.user);
    setAuthEnabled(true);
    setSetupRequired(false);
  };

  const setup = async (email: string, displayName: string, password: string) => {
    const res = await api.setup({ email, displayName, password });
    setUser(res.user);
    setAuthEnabled(true);
    setSetupRequired(false);
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setUser(null);
    await checkStatus();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authEnabled,
        googleAvailable,
        googleDomains,
        setupRequired,
        login,
        setup,
        logout,
        refresh: checkStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
