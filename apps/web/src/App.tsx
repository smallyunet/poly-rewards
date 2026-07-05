import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw, Shield, TrendingUp } from 'lucide-react';

import type { RewardMarketCandidate, RewardQuotePlan, RewardsAppState, RuntimeLogRecord } from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: RewardsAppState }
  | { status: 'error'; error: string };

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const data = await api<RewardsAppState>('/api/state');
      setState({ status: 'ready', data });
    } catch (error) {
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), DASHBOARD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const manualTick = async () => {
    setRefreshing(true);
    try {
      const data = await api<RewardsAppState>('/api/tick', { method: 'POST' });
      setState({ status: 'ready', data });
    } catch (error) {
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      setRefreshing(false);
    }
  };

  if (state.status === 'loading') {
    return <Shell><EmptyState title="Loading rewards monitor" detail="Waiting for the first scanner snapshot." /></Shell>;
  }

  if (state.status === 'error') {
    return <Shell><EmptyState title="Rewards monitor unavailable" detail={state.error} tone="bad" /></Shell>;
  }

  const rewards = state.data.rewards;
  if (!rewards) {
    return <Shell><EmptyState title="No rewards snapshot yet" detail="The worker has not recorded a rewards scan." /></Shell>;
  }

  const eligibleQuotes = rewards.quotePlans.filter((plan) => plan.eligible);
  const topCandidates = rewards.candidates.slice(0, 8);

  return (
    <Shell>
      <header className="topbar">
        <div>
          <p className="eyebrow">Polymarket Rewards Market Making</p>
          <h1>Rewards Scanner</h1>
          <p className="subtle">Monitor-only ranking and dry-run quote planning. Live posting is disabled in this runtime.</p>
        </div>
        <button className="iconButton" onClick={manualTick} disabled={refreshing} title="Run scanner now">
          <RefreshCw size={18} className={refreshing ? 'spin' : ''} />
          <span>Scan</span>
        </button>
      </header>

      <section className="metricGrid" aria-label="Rewards runtime metrics">
        <Metric icon={<Activity size={18} />} label="Scanned" value={String(rewards.marketsScanned)} detail={`${rewards.candidates.length} ranked`} />
        <Metric icon={<TrendingUp size={18} />} label="Planned" value={String(rewards.totals.plannedOrders)} detail={`${rewards.totals.plannedMarkets} markets`} tone={eligibleQuotes.length ? 'good' : 'neutral'} />
        <Metric icon={<Shield size={18} />} label="Notional" value={formatUsd(rewards.totals.plannedNotional)} detail={`cap ${formatUsd(rewards.config.maxGlobalNotional)}`} />
        <Metric icon={<Clock size={18} />} label="Updated" value={formatTime(rewards.updatedAt)} detail={`every ${Math.round(state.data.runtime.tickIntervalMs / 1000)}s`} />
      </section>

      <section className="contentGrid">
        <Panel title="Top Candidates" subtitle="Ranked by reward score minus risk penalties">
          <CandidateTable candidates={topCandidates} />
        </Panel>
        <Panel title="Dry-run Quote Plans" subtitle="BUY YES / BUY NO plans that pass risk caps">
          <QuoteTable plans={rewards.quotePlans} />
        </Panel>
      </section>

      <section className="contentGrid lower">
        <Panel title="Risk Controls" subtitle="Current scanner and quote planner guardrails">
          <RiskControls state={state.data} />
        </Panel>
        <Panel title="Runtime Logs" subtitle="Worker and API events">
          <RuntimeLogs logs={state.data.runtimeLogs.slice(0, 8)} diagnostics={rewards.diagnostics} />
        </Panel>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="appShell">{children}</main>;
}

function Metric({ icon, label, value, detail, tone = 'neutral' }: { icon: React.ReactNode; label: string; value: string; detail: string; tone?: 'good' | 'bad' | 'neutral' }) {
  return (
    <div className={`metricCard ${tone}`}>
      <div className="metricIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function CandidateTable({ candidates }: { candidates: RewardMarketCandidate[] }) {
  if (!candidates.length) return <EmptyState title="No candidates" detail="No reward markets passed scanner ingestion yet." />;
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Reward</th>
            <th>Min</th>
            <th>Max Spread</th>
            <th>Mid</th>
            <th>Net</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((market) => (
            <tr key={market.id}>
              <td className="marketCell">
                <strong>{market.question}</strong>
                <span>{market.category || market.slug || market.conditionId || market.id}</span>
                <TagList tags={market.riskTags} />
              </td>
              <td>{formatUsd(market.dailyReward)}</td>
              <td>{formatShares(market.minSize)}</td>
              <td>{formatPct(market.maxSpread)}</td>
              <td>{market.adjustedMidpoint == null ? '-' : market.adjustedMidpoint.toFixed(3)}</td>
              <td className={market.netScore > 0 ? 'positive' : 'negative'}>{market.netScore.toFixed(3)}</td>
              <td>
                {market.rejectReasons.length ? (
                  <ReasonList reasons={market.rejectReasons} />
                ) : (
                  <Badge tone="good"><CheckCircle2 size={14} /> eligible</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QuoteTable({ plans }: { plans: RewardQuotePlan[] }) {
  const visible = plans.slice(0, 12);
  if (!visible.length) return <EmptyState title="No quote plans" detail="No ranked market currently passes the dry-run quote planner." />;
  return (
    <div className="tableWrap compact">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Side</th>
            <th>Price</th>
            <th>Size</th>
            <th>Notional</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((plan) => (
            <tr key={plan.id}>
              <td className="mono">{shortId(plan.marketId)}</td>
              <td><Badge tone={plan.label === 'YES' ? 'good' : 'neutral'}>{plan.label} BUY</Badge></td>
              <td className="mono">{plan.price.toFixed(3)}</td>
              <td className="mono">{formatShares(plan.size)}</td>
              <td className="mono">{formatUsd(plan.notional)}</td>
              <td className="smallText">{plan.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RiskControls({ state }: { state: RewardsAppState }) {
  const config = state.rewards!.config;
  const rows = [
    ['Global notional cap', formatUsd(config.maxGlobalNotional)],
    ['Per-market notional cap', formatUsd(config.maxMarketNotional)],
    ['Quote size', formatShares(config.quoteSize)],
    ['Quote offset', config.quoteOffset.toFixed(3)],
    ['Min daily reward', formatUsd(config.minDailyReward)],
    ['Min seconds to close', `${Math.round(config.minSecondsToClose / 3600)}h`],
    ['Max open markets', String(config.maxOpenMarkets)],
    ['Live whitelist only', config.liveWhitelistOnly ? 'yes' : 'no'],
  ];
  return (
    <div className="controlGrid">
      {rows.map(([label, value]) => (
        <div className="controlRow" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function RuntimeLogs({ logs, diagnostics }: { logs: RuntimeLogRecord[]; diagnostics: string[] }) {
  const rows = useMemo(() => [
    ...diagnostics.map((message) => ({ id: `diag-${message}`, level: 'warn' as const, createdAt: '', message })),
    ...logs,
  ].slice(0, 10), [logs, diagnostics]);
  if (!rows.length) return <EmptyState title="No logs" detail="The worker has not emitted diagnostics." />;
  return (
    <div className="logList">
      {rows.map((log) => (
        <div className={`logRow ${log.level}`} key={log.id}>
          <AlertTriangle size={14} />
          <span>{log.createdAt ? formatTime(log.createdAt) : 'diag'}</span>
          <p>{log.message}</p>
        </div>
      ))}
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  return <div className="tagList">{tags.slice(0, 4).map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>;
}

function ReasonList({ reasons }: { reasons: string[] }) {
  return (
    <div className="reasonList">
      {reasons.slice(0, 3).map((reason) => <Badge tone="bad" key={reason}>{reason}</Badge>)}
    </div>
  );
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'good' | 'bad' | 'neutral' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function EmptyState({ title, detail, tone = 'neutral' }: { title: string; detail: string; tone?: 'bad' | 'neutral' }) {
  return (
    <div className={`emptyState ${tone}`}>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function formatShares(value: number) {
  return value.toFixed(value >= 100 ? 0 : 2);
}

function formatPct(value: number) {
  return value ? `${(value * 100).toFixed(1)}c` : '-';
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}
