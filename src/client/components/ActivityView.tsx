import { useEffect, useMemo, useState } from 'react';
import { Clock, Info, Keyboard, Loader2 } from 'lucide-react';
import type { Project } from '../../types.js';
import type { ActivitySummary } from '../../core/activity.js';
import { api } from '../lib/api.js';

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function hours(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 10) return `${Math.round(h)} h`;
  if (h >= 1) return `${h.toFixed(1)} h`;
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * Time spent, for billing.
 *
 * Two figures, kept apart because they are not the same kind of number: composition time is an
 * estimate bounded by the clock, and response time is measured. Saying so on the page is the
 * difference between a figure someone can put on an invoice and one they have to re-derive.
 */
export function ActivityView({ projects }: { projects: Project[] }) {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState('');
  const [category, setCategory] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .activity({
        projectId: projectId || undefined,
        category: category || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, category, startDate, endDate]);

  const categories = useMemo(
    () => [...new Set(projects.map((p) => p.category).filter((c): c is string => !!c))].sort(),
    [projects],
  );

  const peakHour = useMemo(() => {
    if (!summary) return null;
    const busiest = [...summary.byHour].sort((a, b) => b.typingMs + b.thinkingMs - (a.typingMs + a.thinkingMs))[0];
    return busiest && busiest.messages > 0 ? busiest : null;
  }, [summary]);

  const maxHourMs = useMemo(
    () => (summary ? Math.max(1, ...summary.byHour.map((h) => h.typingMs + h.thinkingMs)) : 1),
    [summary],
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Temps passé</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Le temps que représentent les conversations, par projet, par jour et par heure.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-card p-6">
        <label className="flex flex-col gap-2 text-sm text-muted-foreground">
          Projet
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setCategory('');
            }}
            className="rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground"
          >
            <option value="">Tous</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm text-muted-foreground">
          Catégorie
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setProjectId('');
            }}
            className="rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground"
          >
            <option value="">Toutes</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm text-muted-foreground">
          Du
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm text-muted-foreground">
          Au
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-xl border border-border bg-background px-4 py-2 text-sm text-foreground"
          />
        </label>
        {loading && <Loader2 className="mb-2 h-4 w-4 animate-spin text-accent" />}
      </div>

      {!summary && !loading && (
        <p className="text-sm text-muted-foreground">Aucune donnée sur cette sélection.</p>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Keyboard className="h-4 w-4" /> Rédaction
              </div>
              <div className="mt-2 text-3xl font-bold text-foreground">{hours(summary.totalTypingMs)}</div>
              <p className="mt-2 text-sm text-muted-foreground">
                Estimé à {summary.keystrokesPerMinute} frappes/min, plafonné par le temps réellement écoulé.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" /> Réponse de l'IA
              </div>
              <div className="mt-2 text-3xl font-bold text-foreground">{hours(summary.totalThinkingMs)}</div>
              <p className="mt-2 text-sm text-muted-foreground">Mesuré, pas estimé : l'attente entre une question et sa réponse.</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Info className="h-4 w-4" /> Sur quoi ça repose
              </div>
              <div className="mt-2 text-3xl font-bold text-foreground">
                {summary.messageCount.toLocaleString('fr-FR')}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                messages, dont {summary.cappedMessageCount.toLocaleString('fr-FR')} où le temps écoulé a limité
                l'estimation — donc mesurés plutôt que déduits.
              </p>
            </div>
          </div>

          {/* Working pattern by hour: the shape of a day, which is what makes a timesheet
              believable when a client asks. */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-base font-semibold text-foreground">Répartition par heure</h2>
            {peakHour && (
              <p className="mt-2 text-sm text-muted-foreground">
                Heure la plus chargée : {String(peakHour.hour).padStart(2, '0')}h — {hours(peakHour.typingMs + peakHour.thinkingMs)}
              </p>
            )}
            <div className="mt-6 flex h-40 items-end gap-2">
              {HOURS.map((h) => {
                const bucket = summary.byHour[h];
                const total = bucket.typingMs + bucket.thinkingMs;
                const height = Math.round((total / maxHourMs) * 100);
                return (
                  <div key={h} className="group flex flex-1 flex-col items-center justify-end gap-2" title={`${String(h).padStart(2, '0')}h — ${hours(total)}`}>
                    <div
                      className="w-full rounded-xl bg-accent/70 transition-colors group-hover:bg-accent"
                      style={{ height: `${Math.max(total > 0 ? 2 : 0, height)}%` }}
                    />
                    <span className="text-sm text-muted-foreground">{h % 3 === 0 ? h : ''}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per project: the table someone actually invoices from. */}
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <h2 className="border-b border-border px-6 py-4 text-base font-semibold text-foreground">Par projet</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-6 py-2 font-medium">Projet</th>
                    <th className="px-6 py-2 text-right font-medium">Rédaction</th>
                    <th className="px-6 py-2 text-right font-medium">Réponse IA</th>
                    <th className="px-6 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byProject.slice(0, 25).map((p) => (
                    <tr key={p.projectId} className="border-b border-border/60 last:border-0">
                      <td className="max-w-xs truncate px-6 py-2 text-foreground">{p.name}</td>
                      <td className="px-6 py-2 text-right text-muted-foreground">{hours(p.typingMs)}</td>
                      <td className="px-6 py-2 text-right text-muted-foreground">{hours(p.thinkingMs)}</td>
                      <td className="px-6 py-2 text-right font-medium text-foreground">{hours(p.typingMs + p.thinkingMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            La rédaction est une estimation : un message n'est jamais compté plus longtemps que le temps écoulé
            depuis le précédent, et le contenu collé (code, courriels cités, blocs injectés) n'est pas compté du
            tout. Le rythme de frappe se règle dans <span className="text-foreground">Compte</span>.
          </p>
        </>
      )}
    </div>
  );
}
