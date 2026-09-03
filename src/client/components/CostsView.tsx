import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  BarChart3,
  Calendar,
  Coins,
  Cpu,
  DollarSign,
  Download,
  Info,
  Euro,
  FolderKanban,
  Layers,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import type { Project } from '../../types.js';
import type {
  CostSummary,
  DateCostPoint,
  ModelCostBreakdown,
  ProjectCostBreakdown,
} from '../../core/cost.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';
import { api } from '../lib/api.js';

type MetricMode = 'EUR' | 'USD' | 'TOKENS';
type TimePeriod = '7d' | '30d' | '90d' | '1y' | 'all' | 'custom';
type ActiveTab = 'models' | 'projects' | 'dates';
type Granularity = 'day' | 'week' | 'month';

const ENGINE_COLORS: Record<string, { label: string; bg: string; text: string; fill: string }> = {
  'claude-code': { label: 'Anthropic (Claude Code)', bg: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', fill: '#d97706' },
  codex: { label: 'OpenAI (Codex / ChatGPT)', bg: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', fill: '#10b981' },
  antigravity: { label: 'Google (Antigravity)', bg: 'bg-blue-500/15', text: 'text-blue-600 dark:text-blue-400', fill: '#3b82f6' },
};

function formatCurrency(amount: number, currency: 'EUR' | 'USD'): string {
  return amount.toLocaleString('fr-FR', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Same amount, in whichever currency the toggle is showing. */
function formatInCurrency(usd: number, currency: 'EUR' | 'USD' | string, eurRate: number): string {
  return currency === 'USD' ? formatCurrency(usd, 'USD') : formatCurrency(usd * eurRate, 'EUR');
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return n.toLocaleString('fr-FR');
}

function formatTokensFull(n: number): string {
  return n.toLocaleString('fr-FR');
}

function formatDateShort(dateStr: string): string {
  if (!dateStr || dateStr.length < 10) return dateStr;
  const parts = dateStr.slice(0, 10).split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}`;
  }
  return dateStr;
}

export function CostsView({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState<string>('');
  const [engine, setEngine] = useState<string>('');
  const [period, setPeriod] = useState<TimePeriod>('all');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [currency, setCurrency] = useState<MetricMode>('EUR');
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [activeTab, setActiveTab] = useState<ActiveTab>('models');
  const [hoveredPoint, setHoveredPoint] = useState<DateCostPoint | null>(null);

  // Table sorting
  const [modelSort, setModelSort] = useState<{ key: keyof ModelCostBreakdown; asc: boolean }>({ key: 'costEur', asc: false });
  const [projectSort, setProjectSort] = useState<{ key: keyof ProjectCostBreakdown; asc: boolean }>({ key: 'costEur', asc: false });
  const [dateSort, setDateSort] = useState<{ key: keyof DateCostPoint; asc: boolean }>({ key: 'date', asc: false });

  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Calculate date boundaries based on period quick-select
  useEffect(() => {
    if (period === 'all') {
      setStartDate('');
      setEndDate('');
      return;
    }
    if (period === 'custom') {
      return;
    }
    const now = new Date();
    const end = now.toISOString().slice(0, 10);
    const startObj = new Date(now);
    if (period === '7d') startObj.setDate(now.getDate() - 7);
    else if (period === '30d') startObj.setDate(now.getDate() - 30);
    else if (period === '90d') startObj.setDate(now.getDate() - 90);
    else if (period === '1y') startObj.setFullYear(now.getFullYear() - 1);
    setStartDate(startObj.toISOString().slice(0, 10));
    setEndDate(end);
  }, [period]);

  // Fetch summary
  useEffect(() => {
    setLoading(true);
    api
      .costs({
        projectId: projectId || undefined,
        engine: engine || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      })
      .then((data) => {
        setSummary(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [projectId, engine, startDate, endDate]);

  const visibleProjects = useMemo(() => {
    return projects.filter((p) => p.id !== UNASSIGNED_PROJECT_ID && !p.archived);
  }, [projects]);

  // Group date points by granularity if needed
  const chartData = useMemo(() => {
    if (!summary?.byDate || summary.byDate.length === 0) return [];
    if (granularity === 'day') return summary.byDate;

    // Grouping by week or month
    const groups = new Map<string, DateCostPoint>();
    for (const pt of summary.byDate) {
      let key = pt.date;
      if (granularity === 'month') {
        key = pt.date.slice(0, 7); // YYYY-MM
      } else if (granularity === 'week') {
        const d = new Date(pt.date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
        const monday = new Date(d.setDate(diff));
        key = `Sem. ${monday.toISOString().slice(0, 10)}`;
      }

      const existing = groups.get(key) ?? {
        date: key,
        costUsd: 0,
        costEur: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        messageCount: 0,
        byEngine: {},
        byModel: {},
      };

      existing.costUsd += pt.costUsd;
      existing.costEur += pt.costEur;
      existing.inputTokens += pt.inputTokens;
      existing.outputTokens += pt.outputTokens;
      existing.totalTokens += pt.totalTokens;
      existing.messageCount += pt.messageCount;

      for (const [eng, rec] of Object.entries(pt.byEngine)) {
        const r = existing.byEngine[eng] ?? { costUsd: 0, costEur: 0, totalTokens: 0 };
        r.costUsd += rec.costUsd;
        r.costEur += rec.costEur;
        r.totalTokens += rec.totalTokens;
        existing.byEngine[eng] = r;
      }

      for (const [mod, rec] of Object.entries(pt.byModel)) {
        const r = existing.byModel[mod] ?? { costUsd: 0, costEur: 0, totalTokens: 0 };
        r.costUsd += rec.costUsd;
        r.costEur += rec.costEur;
        r.totalTokens += rec.totalTokens;
        existing.byModel[mod] = r;
      }

      groups.set(key, existing);
    }
    return Array.from(groups.values());
  }, [summary?.byDate, granularity]);

  // Max value for chart scaling
  const chartMax = useMemo(() => {
    if (chartData.length === 0) return 1;
    return Math.max(
      ...chartData.map((d) => {
        if (currency === 'EUR') return d.costEur;
        if (currency === 'USD') return d.costUsd;
        return d.totalTokens;
      }),
      0.01,
    );
  }, [chartData, currency]);

  // Sorted tables
  const sortedModels = useMemo(() => {
    if (!summary?.byModel) return [];
    return [...summary.byModel].sort((a, b) => {
      const vA = a[modelSort.key];
      const vB = b[modelSort.key];
      if (typeof vA === 'string' && typeof vB === 'string') {
        return modelSort.asc ? vA.localeCompare(vB) : vB.localeCompare(vA);
      }
      return modelSort.asc ? Number(vA) - Number(vB) : Number(vB) - Number(vA);
    });
  }, [summary?.byModel, modelSort]);

  const sortedProjects = useMemo(() => {
    if (!summary?.byProject) return [];
    return [...summary.byProject].sort((a, b) => {
      const vA = a[projectSort.key];
      const vB = b[projectSort.key];
      if (typeof vA === 'string' && typeof vB === 'string') {
        return projectSort.asc ? vA.localeCompare(vB) : vB.localeCompare(vA);
      }
      return projectSort.asc ? Number(vA) - Number(vB) : Number(vB) - Number(vA);
    });
  }, [summary?.byProject, projectSort]);

  const sortedDates = useMemo(() => {
    if (!summary?.byDate) return [];
    return [...summary.byDate].sort((a, b) => {
      const vA = a[dateSort.key];
      const vB = b[dateSort.key];
      if (typeof vA === 'string' && typeof vB === 'string') {
        return dateSort.asc ? vA.localeCompare(vB) : vB.localeCompare(vA);
      }
      return dateSort.asc ? Number(vA) - Number(vB) : Number(vB) - Number(vA);
    });
  }, [summary?.byDate, dateSort]);

  // Export JSON summary
  const handleExportJson = () => {
    if (!summary) return;
    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sync-hub-costs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-6xl overflow-y-auto p-6 space-y-6">
      {/* Header Title & Intro */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-foreground">Tableau de Bord des Coûts & Tokens</h1>
            <span className="inline-flex items-center gap-2 rounded-full bg-accent-muted px-4 py-2 text-sm font-medium text-accent-muted-foreground">
              <Sparkles className="h-3 w-3" /> Multi-supports
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Analyse détaillée de votre consommation de tokens et des coûts équivalents par modèle, par projet et par date (Anthropic, OpenAI, Google).
          </p>
        </div>

        {/* Currency & Export controls */}
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-border bg-card p-2 text-sm">
            <button
              onClick={() => setCurrency('EUR')}
              className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 font-medium transition-colors ${
                currency === 'EUR' ? 'bg-accent text-accent-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Euro className="h-4 w-4" /> EUR
            </button>
            <button
              onClick={() => setCurrency('USD')}
              className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 font-medium transition-colors ${
                currency === 'USD' ? 'bg-accent text-accent-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <DollarSign className="h-4 w-4" /> USD
            </button>
            <button
              onClick={() => setCurrency('TOKENS')}
              className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 font-medium transition-colors ${
                currency === 'TOKENS' ? 'bg-accent text-accent-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Coins className="h-4 w-4" /> Tokens
            </button>
          </div>

          <button
            onClick={handleExportJson}
            title="Exporter les données en JSON"
            className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Download className="h-3.5 w-3.5" /> Exporter
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Quick Period selector */}
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-muted-foreground mr-2">Période :</span>
            {(
              [
                { key: '7d', label: '7 jours' },
                { key: '30d', label: '30 jours' },
                { key: '90d', label: '90 jours' },
                { key: '1y', label: '1 an' },
                { key: 'all', label: 'Tout l’historique' },
                { key: 'custom', label: 'Personnalisée' },
              ] as const
            ).map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={`rounded-xl px-4 py-2 font-medium transition-colors ${
                  period === p.key
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Custom Date Inputs if custom period */}
          {period === 'custom' && (
            <div className="flex items-center gap-2 text-sm">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-xl border border-border bg-background px-2 py-2 text-foreground"
              />
              <span className="text-muted-foreground">à</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-xl border border-border bg-background px-2 py-2 text-foreground"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-border/50 text-sm">
          {/* Engine filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="costs-engine-filter" className="font-medium text-muted-foreground">
              Support / Outil :
            </label>
            <select
              id="costs-engine-filter"
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              className="rounded-xl border border-border bg-background px-4 py-2 text-foreground font-medium"
            >
              <option value="">Tous les supports (Anthropic, OpenAI, Google)</option>
              <option value="claude-code">Anthropic (Claude Code)</option>
              <option value="codex">OpenAI (Codex / ChatGPT)</option>
              <option value="antigravity">Google (Antigravity)</option>
            </select>
          </div>

          {/* Project filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="costs-project-filter" className="font-medium text-muted-foreground">
              Projet :
            </label>
            <select
              id="costs-project-filter"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="rounded-xl border border-border bg-background px-4 py-2 text-foreground max-w-xs truncate"
            >
              <option value="">Tous les projets ({visibleProjects.length})</option>
              {visibleProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.category ? `[${p.category}]` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Granularity */}
          <div className="flex items-center gap-2 ml-auto">
            <label className="font-medium text-muted-foreground">Échelle :</label>
            <div className="inline-flex rounded-xl border border-border bg-muted p-2">
              {(
                [
                  { key: 'day', label: 'Jour' },
                  { key: 'week', label: 'Semaine' },
                  { key: 'month', label: 'Mois' },
                ] as const
              ).map((g) => (
                <button
                  key={g.key}
                  onClick={() => setGranularity(g.key)}
                  className={`rounded-xl px-2 py-2 text-sm font-medium transition-colors ${
                    granularity === g.key ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading && !summary && (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span>Calcul des consommations en cours…</span>
        </div>
      )}

      {summary && (
        <>
          {/* KPI Summary Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Total Cost Card */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Coût Total Estimé</span>
                <div className="rounded-xl bg-accent-muted p-2 text-accent-muted-foreground">
                  <Coins className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-2 text-3xl font-bold text-foreground">
                {currency === 'USD' ? formatCurrency(summary.totalCostUsd, 'USD') : formatCurrency(summary.totalCostEur, 'EUR')}
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <span>≈ {currency === 'USD' ? formatCurrency(summary.totalCostEur, 'EUR') : formatCurrency(summary.totalCostUsd, 'USD')}</span>
                <span className="text-border">|</span>
                <span className="text-sm text-muted-foreground/80">Taux: 1$ = {summary.eurRate}€</span>
              </div>
            </div>

            {/* Total Tokens Card */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Tokens Consommés</span>
                <div className="rounded-xl bg-emerald-500/15 p-2 text-emerald-600 dark:text-emerald-400">
                  <Cpu className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-2 text-3xl font-bold text-foreground">{formatTokensCompact(summary.totalTokens)}</div>
              <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <span>In: {formatTokensCompact(summary.totalInputTokens)}</span>
                <span>•</span>
                <span>Out: {formatTokensCompact(summary.totalOutputTokens)}</span>
                <span>•</span>
                <span>Cache: {formatTokensCompact(summary.totalCachedTokens)}</span>
              </div>
            </div>

            {/* Messages Card */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Messages & Tours</span>
                <div className="rounded-xl bg-blue-500/15 p-2 text-blue-600 dark:text-blue-400">
                  <Layers className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-2 text-3xl font-bold text-foreground">{formatTokensFull(summary.totalMessages)}</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {summary.byModel.length} modèle(s) • {summary.byProject.length} projet(s)
              </div>
            </div>

            {/* Top Engine / Top Model */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Outil Dominant</span>
                <div className="rounded-xl bg-amber-500/15 p-2 text-amber-600 dark:text-amber-400">
                  <TrendingUp className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-2 text-base font-bold text-foreground truncate">
                {summary.byEngine[0]?.label ?? 'N/A'}
              </div>
              <div className="mt-2 text-sm text-muted-foreground truncate">
                Top modèle : <span className="font-mono text-foreground">{summary.byModel[0]?.model ?? 'N/A'}</span>
              </div>
            </div>
          </div>

          {/* Where each figure comes from. Without this the headline read as one measured number
              while quietly ignoring unpriced models and 62k archived messages — the angle blind
              spot that made costs look like they began in May. */}
          <div className="rounded-xl border border-border bg-card px-6 py-4 shadow-xs">
            <div className="flex items-center gap-2 mb-4">
              <Info className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold text-foreground">Provenance des chiffres</h3>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-border/60 bg-background/50 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Mesuré
                </div>
                <div className="mt-2 text-xl font-bold text-foreground">{formatInCurrency(summary.measuredCostUsd, currency, summary.eurRate)}</div>
                <p className="mt-2 text-sm leading-snug text-muted-foreground">
                  Consommation rapportée par l'outil, tarif publié par l'éditeur.
                </p>
              </div>

              <div className="rounded-xl border border-border/60 bg-background/50 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  Interpolé
                </div>
                <div className="mt-2 text-xl font-bold text-foreground">{formatInCurrency(summary.interpolatedCostUsd, currency, summary.eurRate)}</div>
                <p className="mt-2 text-sm leading-snug text-muted-foreground">
                  {summary.interpolatedMessageCount.toLocaleString('fr-FR')} message(s) sur un modèle sans tarif publié —
                  taux déduit de ses deux voisins immédiats. Compris dans le total.
                </p>
              </div>

              <div className="rounded-xl border border-dashed border-border bg-background/50 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                  Archives — borne haute
                </div>
                <div className="mt-2 text-xl font-bold text-muted-foreground">≤ {formatInCurrency(summary.upperBoundCostUsd, currency, summary.eurRate)}</div>
                <p className="mt-2 text-sm leading-snug text-muted-foreground">
                  {summary.upperBoundMessageCount.toLocaleString('fr-FR')} message(s) importés de Claude.ai / ChatGPT
                  ({formatTokensCompact(summary.upperBoundTokens)} tokens). Un export ne dit pas quel modèle a répondu :
                  le modèle phare de l'époque est supposé, donc le tarif le plus cher.{' '}
                  <strong className="text-foreground">Exclu du total et du graphique.</strong>
                </p>
              </div>
            </div>
            {summary.unpricedMessageCount > 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                {summary.unpricedMessageCount.toLocaleString('fr-FR')} message(s) restent non chiffrés : ni modèle connu,
                ni tarif déductible. Ils comptent dans les tokens, pas dans le coût.
              </p>
            )}
          </div>

          {/* Interactive Time-Series Chart */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-xs relative">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-accent" />
                <h3 className="text-sm font-semibold text-foreground">
                  Évolution Chronologique ({currency === 'EUR' ? 'Coût en €' : currency === 'USD' ? 'Coût en $' : 'Volume de Tokens'})
                </h3>
              </div>
              <div className="flex items-center gap-4 text-sm">
                {Object.entries(ENGINE_COLORS).map(([engKey, meta]) => (
                  <div key={engKey} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: meta.fill }} />
                    <span className="text-muted-foreground">{meta.label.split(' ')[0]}</span>
                  </div>
                ))}
              </div>
            </div>

            {chartData.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">Aucune donnée disponible pour cette plage de dates.</div>
            ) : (
              <div className="relative">
                {/* SVG Stacked Bar Chart */}
                <div className="h-64 w-full">
                  <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 1000 200">
                    {/* Horizontal Grid lines */}
                    {[0, 50, 100, 150].map((y) => (
                      <line
                        key={y}
                        x1="0"
                        y1={y}
                        x2="1000"
                        y2={y}
                        stroke="currentColor"
                        strokeDasharray="4 4"
                        className="text-border/60"
                        strokeWidth="1"
                      />
                    ))}

                    {/* Bars */}
                    {chartData.map((d, idx) => {
                      const count = chartData.length;
                      const barWidth = Math.max(4, Math.min(36, 900 / count - 4));
                      const x = (idx + 0.5) * (1000 / count) - barWidth / 2;

                      // Breakdown per engine
                      const claudeVal =
                        currency === 'EUR'
                          ? d.byEngine['claude-code']?.costEur || 0
                          : currency === 'USD'
                          ? d.byEngine['claude-code']?.costUsd || 0
                          : d.byEngine['claude-code']?.totalTokens || 0;

                      const codexVal =
                        currency === 'EUR'
                          ? d.byEngine['codex']?.costEur || 0
                          : currency === 'USD'
                          ? d.byEngine['codex']?.costUsd || 0
                          : d.byEngine['codex']?.totalTokens || 0;

                      const agyVal =
                        currency === 'EUR'
                          ? d.byEngine['antigravity']?.costEur || 0
                          : currency === 'USD'
                          ? d.byEngine['antigravity']?.costUsd || 0
                          : d.byEngine['antigravity']?.totalTokens || 0;

                      const hClaude = (claudeVal / chartMax) * 180;
                      const hCodex = (codexVal / chartMax) * 180;
                      const hAgy = (agyVal / chartMax) * 180;

                      const isHovered = hoveredPoint?.date === d.date;

                      return (
                        <g
                          key={d.date}
                          className="cursor-pointer transition-opacity"
                          onMouseEnter={() => setHoveredPoint(d)}
                          onMouseLeave={() => setHoveredPoint(null)}
                        >
                          {/* Anthropic segment */}
                          {hClaude > 0 && (
                            <rect
                              x={x}
                              y={200 - hClaude}
                              width={barWidth}
                              height={hClaude}
                              fill={ENGINE_COLORS['claude-code'].fill}
                              rx={hCodex + hAgy === 0 ? 3 : 0}
                              className={isHovered ? 'brightness-125' : 'opacity-90 hover:opacity-100'}
                            />
                          )}
                          {/* OpenAI segment */}
                          {hCodex > 0 && (
                            <rect
                              x={x}
                              y={200 - hClaude - hCodex}
                              width={barWidth}
                              height={hCodex}
                              fill={ENGINE_COLORS['codex'].fill}
                              rx={hAgy === 0 ? 3 : 0}
                              className={isHovered ? 'brightness-125' : 'opacity-90 hover:opacity-100'}
                            />
                          )}
                          {/* Antigravity segment */}
                          {hAgy > 0 && (
                            <rect
                              x={x}
                              y={200 - hClaude - hCodex - hAgy}
                              width={barWidth}
                              height={hAgy}
                              fill={ENGINE_COLORS['antigravity'].fill}
                              rx={3}
                              className={isHovered ? 'brightness-125' : 'opacity-90 hover:opacity-100'}
                            />
                          )}

                          {/* Hover outline */}
                          {isHovered && (
                            <rect
                              x={x - 2}
                              y={200 - (hClaude + hCodex + hAgy) - 2}
                              width={barWidth + 4}
                              height={hClaude + hCodex + hAgy + 4}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              className="text-foreground"
                              rx="4"
                            />
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>

                {/* X-axis date labels */}
                <div className="mt-2 flex justify-between text-sm text-muted-foreground font-mono px-2">
                  <span>{formatDateShort(chartData[0]?.date ?? '')}</span>
                  {chartData.length > 2 && (
                    <span>{formatDateShort(chartData[Math.floor(chartData.length / 2)]?.date ?? '')}</span>
                  )}
                  <span>{formatDateShort(chartData[chartData.length - 1]?.date ?? '')}</span>
                </div>

                {/* Floating Tooltip */}
                {hoveredPoint && (
                  <div
                    className="absolute z-20 pointer-events-none rounded-xl border border-border bg-card p-4 shadow-lg text-sm space-y-2 w-60"
                    style={{
                      left: `${Math.min(
                        Math.max(10, (chartData.indexOf(hoveredPoint) / chartData.length) * 100 - 15),
                        70,
                      )}%`,
                      top: '10px',
                    }}
                  >
                    <div className="font-semibold text-foreground flex items-center justify-between border-b border-border/60 pb-2">
                      <span>{hoveredPoint.date}</span>
                      <span className="font-mono text-accent">
                        {currency === 'EUR'
                          ? formatCurrency(hoveredPoint.costEur, 'EUR')
                          : currency === 'USD'
                          ? formatCurrency(hoveredPoint.costUsd, 'USD')
                          : formatTokensCompact(hoveredPoint.totalTokens)}
                      </span>
                    </div>

                    <div className="space-y-2 pt-2 text-sm">
                      {Object.entries(hoveredPoint.byEngine).map(([eng, rec]) => {
                        const meta = ENGINE_COLORS[eng] ?? { label: eng, fill: '#94a3b8' };
                        return (
                          <div key={eng} className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.fill }} />
                              {meta.label.split(' ')[0]} :
                            </span>
                            <span className="font-mono text-foreground">
                              {currency === 'EUR'
                                ? formatCurrency(rec.costEur, 'EUR')
                                : currency === 'USD'
                                ? formatCurrency(rec.costUsd, 'USD')
                                : formatTokensCompact(rec.totalTokens)}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="border-t border-border/60 pt-2 text-sm text-muted-foreground flex justify-between">
                      <span>Tokens In/Out:</span>
                      <span className="font-mono">
                        {formatTokensCompact(hoveredPoint.inputTokens)} / {formatTokensCompact(hoveredPoint.outputTokens)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Breakdown Distributions Row */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* By Support / Engine */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs space-y-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-accent" />
                <h4 className="text-sm font-semibold text-foreground">Répartition par Support</h4>
              </div>
              <div className="space-y-4">
                {summary.byEngine.map((e) => {
                  const meta = ENGINE_COLORS[e.engine] ?? { label: e.engine, fill: '#94a3b8' };
                  return (
                    <div key={e.engine} className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 font-medium text-foreground">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.fill }} />
                          {e.label}
                        </span>
                        <span className="font-mono font-semibold text-foreground">
                          {currency === 'USD' ? formatCurrency(e.costUsd, 'USD') : formatCurrency(e.costEur, 'EUR')}
                          <span className="ml-2 text-sm font-normal text-muted-foreground">({e.percentage.toFixed(1)}%)</span>
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${Math.max(e.percentage, 2)}%`, backgroundColor: meta.fill }}
                        />
                      </div>
                      <div className="flex justify-between text-sm text-muted-foreground">
                        <span>{formatTokensFull(e.messageCount)} msgs</span>
                        <span>{formatTokensCompact(e.totalTokens)} tokens</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top 5 Projects */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs space-y-4">
              <div className="flex items-center gap-2">
                <FolderKanban className="h-4 w-4 text-accent" />
                <h4 className="text-sm font-semibold text-foreground">Top Projets les Plus Consommateurs</h4>
              </div>
              <div className="space-y-2">
                {summary.byProject.slice(0, 5).map((p) => (
                  <div key={p.projectId} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground truncate max-w-[150px]" title={p.projectName}>
                        {p.projectName}
                      </span>
                      <span className="font-mono font-semibold text-foreground">
                        {currency === 'USD' ? formatCurrency(p.costUsd, 'USD') : formatCurrency(p.costEur, 'EUR')}
                        <span className="ml-2 text-sm font-normal text-muted-foreground">({p.percentage.toFixed(1)}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${Math.max(p.percentage, 2)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top 5 Models */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs space-y-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-accent" />
                <h4 className="text-sm font-semibold text-foreground">Top Modèles</h4>
              </div>
              <div className="space-y-2">
                {summary.byModel.slice(0, 5).map((m) => (
                  <div key={m.model} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-mono text-sm text-foreground truncate max-w-[160px]" title={m.model}>
                        {m.model}
                      </span>
                      <span className="font-mono font-semibold text-foreground">
                        {currency === 'USD' ? formatCurrency(m.costUsd, 'USD') : formatCurrency(m.costEur, 'EUR')}
                        <span className="ml-2 text-sm font-normal text-muted-foreground">({m.percentage.toFixed(1)}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all"
                        style={{ width: `${Math.max(m.percentage, 2)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Detailed Data Tables with Tabs */}
          <div className="rounded-xl border border-border bg-card shadow-xs overflow-hidden">
            {/* Table Tabs */}
            <div className="flex items-center border-b border-border bg-muted/40 px-4 pt-2 gap-2 text-sm">
              <button
                onClick={() => setActiveTab('models')}
                className={`flex items-center gap-2 border-b-2 px-4 py-2 font-medium transition-colors ${
                  activeTab === 'models'
                    ? 'border-accent text-accent font-semibold'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Cpu className="h-3.5 w-3.5" /> Par Modèle ({summary.byModel.length})
              </button>
              <button
                onClick={() => setActiveTab('projects')}
                className={`flex items-center gap-2 border-b-2 px-4 py-2 font-medium transition-colors ${
                  activeTab === 'projects'
                    ? 'border-accent text-accent font-semibold'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <FolderKanban className="h-3.5 w-3.5" /> Par Projet ({summary.byProject.length})
              </button>
              <button
                onClick={() => setActiveTab('dates')}
                className={`flex items-center gap-2 border-b-2 px-4 py-2 font-medium transition-colors ${
                  activeTab === 'dates'
                    ? 'border-accent text-accent font-semibold'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Calendar className="h-3.5 w-3.5" /> Historique par Date ({summary.byDate.length})
              </button>
            </div>

            {/* Tab 1: Models Table */}
            {activeTab === 'models' && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20 text-muted-foreground">
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setModelSort({ key: 'model', asc: modelSort.key === 'model' ? !modelSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Modèle <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th className="px-4 py-4 font-medium">Fournisseur</th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setModelSort({ key: 'messageCount', asc: modelSort.key === 'messageCount' ? !modelSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Messages <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setModelSort({ key: 'inputTokens', asc: modelSort.key === 'inputTokens' ? !modelSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Tokens Entrée <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setModelSort({ key: 'outputTokens', asc: modelSort.key === 'outputTokens' ? !modelSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Tokens Sortie <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th className="px-4 py-4 font-medium">Cache (Read/Write)</th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setModelSort({ key: 'costEur', asc: modelSort.key === 'costEur' ? !modelSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Coût Estimé (€) <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setModelSort({ key: 'costUsd', asc: modelSort.key === 'costUsd' ? !modelSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Coût ($) <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th className="px-4 py-4 font-medium text-right">% Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedModels.map((row) => (
                      <tr key={row.model} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-4 font-mono text-foreground font-semibold">{row.model}</td>
                        <td className="px-4 py-4">
                          <span
                            className={`inline-flex rounded-xl px-2 py-2 text-sm font-medium ${
                              row.provider === 'Anthropic'
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                : row.provider === 'OpenAI'
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                : 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                            }`}
                          >
                            {row.provider}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-foreground">{formatTokensFull(row.messageCount)}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatTokensFull(row.inputTokens)}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatTokensFull(row.outputTokens)}</td>
                        <td className="px-4 py-4 font-mono text-sm text-muted-foreground">
                          {formatTokensCompact(row.cacheReadTokens + row.cachedTokens)} r / {formatTokensCompact(row.cacheWriteTokens)} w
                        </td>
                        <td className="px-4 py-4 font-mono font-semibold text-foreground">{formatCurrency(row.costEur, 'EUR')}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatCurrency(row.costUsd, 'USD')}</td>
                        <td className="px-4 py-4 font-mono text-right font-medium text-foreground">{row.percentage.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Tab 2: Projects Table */}
            {activeTab === 'projects' && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20 text-muted-foreground">
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setProjectSort({ key: 'projectName', asc: projectSort.key === 'projectName' ? !projectSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Projet <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th className="px-4 py-4 font-medium">Catégorie</th>
                      <th className="px-4 py-4 font-medium">Supports Utilisés</th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setProjectSort({ key: 'messageCount', asc: projectSort.key === 'messageCount' ? !projectSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Messages <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setProjectSort({ key: 'totalTokens', asc: projectSort.key === 'totalTokens' ? !projectSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Tokens Totaux <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setProjectSort({ key: 'costEur', asc: projectSort.key === 'costEur' ? !projectSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Coût Estimé (€) <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setProjectSort({ key: 'costUsd', asc: projectSort.key === 'costUsd' ? !projectSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Coût ($) <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th className="px-4 py-4 font-medium text-right">% Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedProjects.map((row) => (
                      <tr key={row.projectId} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-4 font-medium text-foreground">{row.projectName}</td>
                        <td className="px-4 py-4">
                          {row.category ? (
                            <span className="inline-flex rounded-xl bg-muted px-2 py-2 text-sm font-medium text-muted-foreground">
                              {row.category}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-2">
                            {row.engines.map((eng) => (
                              <span
                                key={eng}
                                className={`rounded-xl px-2 py-2 text-sm font-medium ${
                                  ENGINE_COLORS[eng]?.bg ?? 'bg-muted'
                                } ${ENGINE_COLORS[eng]?.text ?? 'text-foreground'}`}
                              >
                                {eng === 'claude-code' ? 'Claude' : eng === 'codex' ? 'Codex' : 'Antigravity'}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-foreground">{formatTokensFull(row.messageCount)}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatTokensCompact(row.totalTokens)}</td>
                        <td className="px-4 py-4 font-mono font-semibold text-foreground">{formatCurrency(row.costEur, 'EUR')}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatCurrency(row.costUsd, 'USD')}</td>
                        <td className="px-4 py-4 font-mono text-right font-medium text-foreground">{row.percentage.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Tab 3: Daily Timeline Table */}
            {activeTab === 'dates' && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20 text-muted-foreground">
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setDateSort({ key: 'date', asc: dateSort.key === 'date' ? !dateSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Date <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setDateSort({ key: 'messageCount', asc: dateSort.key === 'messageCount' ? !dateSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Messages <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th className="px-4 py-4 font-medium">Tokens Entrée</th>
                      <th className="px-4 py-4 font-medium">Tokens Sortie</th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground"
                        onClick={() => setDateSort({ key: 'totalTokens', asc: dateSort.key === 'totalTokens' ? !dateSort.asc : false })}
                      >
                        <div className="flex items-center gap-2">Tokens Totaux <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                      <th className="px-4 py-4 font-medium">Claude Code (€)</th>
                      <th className="px-4 py-4 font-medium">Codex / ChatGPT (€)</th>
                      <th className="px-4 py-4 font-medium">Antigravity (€)</th>
                      <th
                        className="cursor-pointer px-4 py-4 font-medium hover:text-foreground text-right"
                        onClick={() => setDateSort({ key: 'costEur', asc: dateSort.key === 'costEur' ? !dateSort.asc : false })}
                      >
                        <div className="flex items-center justify-end gap-2">Total (€) <ArrowUpDown className="h-3 w-3" /></div>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sortedDates.map((row) => (
                      <tr key={row.date} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-4 font-medium text-foreground">{row.date}</td>
                        <td className="px-4 py-4 text-foreground">{formatTokensFull(row.messageCount)}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatTokensCompact(row.inputTokens)}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatTokensCompact(row.outputTokens)}</td>
                        <td className="px-4 py-4 font-mono text-muted-foreground">{formatTokensCompact(row.totalTokens)}</td>
                        <td className="px-4 py-4 font-mono text-amber-600 dark:text-amber-400">
                          {formatCurrency(row.byEngine['claude-code']?.costEur || 0, 'EUR')}
                        </td>
                        <td className="px-4 py-4 font-mono text-emerald-600 dark:text-emerald-400">
                          {formatCurrency(row.byEngine['codex']?.costEur || 0, 'EUR')}
                        </td>
                        <td className="px-4 py-4 font-mono text-blue-600 dark:text-blue-400">
                          {formatCurrency(row.byEngine['antigravity']?.costEur || 0, 'EUR')}
                        </td>
                        <td className="px-4 py-4 font-mono font-bold text-foreground text-right">
                          {formatCurrency(row.costEur, 'EUR')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

