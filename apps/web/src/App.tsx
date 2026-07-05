import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BadgeDollarSign,
  Banknote,
  BarChart3,
  CheckCircle2,
  CircleDot,
  Gauge,
  Layers,
  LineChart,
  ListChecks,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  WalletCards,
  XCircle,
  Zap,
} from 'lucide-react';

import type {
  RewardExecutionEvent,
  RewardFillRecord,
  RewardInventorySummary,
  RewardManagedOrder,
  RewardMarketCandidate,
  RewardQuotePlan,
  RewardsRuntimeConfig,
  RewardsAppState,
  RuntimeLogRecord,
} from '../../../packages/shared/src';
import { api, DASHBOARD_REFRESH_MS } from './lib/api';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: RewardsAppState }
  | { status: 'error'; error: string };

type DashboardTab = 'strategy' | 'markets' | 'orders' | 'risk' | 'events';
type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => readTabFromUrl());
  const latestLoadId = useRef(0);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    const loadId = latestLoadId.current + 1;
    latestLoadId.current = loadId;
    try {
      const data = await api<RewardsAppState>('/api/state');
      if (!mounted.current || loadId !== latestLoadId.current) return;
      setState({ status: 'ready', data });
    } catch (error) {
      if (!mounted.current || loadId !== latestLoadId.current) return;
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const selectTab = useCallback((tab: DashboardTab) => {
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), DASHBOARD_REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const syncTabFromUrl = () => setActiveTab(readTabFromUrl());
    window.addEventListener('popstate', syncTabFromUrl);
    window.addEventListener('hashchange', syncTabFromUrl);
    syncTabFromUrl();
    return () => {
      window.removeEventListener('popstate', syncTabFromUrl);
      window.removeEventListener('hashchange', syncTabFromUrl);
    };
  }, []);

  if (state.status === 'loading') {
    return <Shell><EmptyState title="Loading rewards workspace" detail="Waiting for the worker to publish the first scanner snapshot." /></Shell>;
  }

  if (state.status === 'error') {
    return <Shell><EmptyState title="Rewards workspace unavailable" detail={state.error} tone="bad" /></Shell>;
  }

  const rewards = state.data.rewards;
  if (!rewards) {
    return <Shell><EmptyState title="No rewards snapshot yet" detail="The API is up, but the scanner has not recorded a rewards scan." /></Shell>;
  }

  const insight = buildStrategyInsight(state.data);
  const execution = state.data.execution;

  return (
    <Shell>
      <header className="hero">
        <div className="heroMain">
          <div className="heroKicker">
            <span className={`statusDot ${insight.modeTone}`} />
            <span>Polymarket Rewards Market Making</span>
          </div>
          <h1>Strategy Control Room</h1>
          <p>
            Two-sided reward quoting with live order reconciliation, capital caps, inventory guards, and
            cancel/repost controls. The dashboard focuses on whether the strategy is earning useful queue
            exposure, not just whether orders are being posted.
          </p>
        </div>
        <div className="heroActions">
          <div className={`modePill ${insight.modeTone}`}>
            {execution?.mode === 'live' ? <Zap size={16} /> : <PauseCircle size={16} />}
            <span>{execution?.mode === 'live' ? 'Live execution' : 'Monitor only'}</span>
          </div>
          <div className="modePill">
            <RefreshCw size={16} />
            <span>Auto every {Math.round(state.data.runtime.tickIntervalMs / 1000)}s</span>
          </div>
          <div className="scheduleText">
            Next scan {state.data.runtime.nextTickAt ? formatTime(state.data.runtime.nextTickAt) : '-'}
          </div>
        </div>
      </header>

      <section className="summaryGrid" aria-label="Strategy summary">
        <SummaryCard icon={<Activity size={18} />} label="Market scan" value={String(rewards.marketsScanned)} detail={`${rewards.totals.plannedOrders} eligible plans`} />
        <SummaryCard icon={<BadgeDollarSign size={18} />} label="Visible daily rewards" value={formatUsd(rewards.totals.dailyRewardVisible)} detail={`${rewards.totals.rejectedMarkets} rejected markets`} tone="good" />
        <SummaryCard icon={<WalletCards size={18} />} label="Live exposure" value={formatUsd(execution?.totals.activeNotional ?? 0)} detail={`${execution?.totals.activeOrders ?? 0} active orders`} tone={insight.exposureTone} />
        <SummaryCard icon={<Banknote size={18} />} label="Collateral" value={execution?.collateralBalance == null ? '-' : formatUsd(execution.collateralBalance)} detail={`reserve ${formatUsd(rewards.config.minCollateralBalance)}`} tone={insight.capitalTone} />
        <SummaryCard icon={<LineChart size={18} />} label="Fills" value={formatShares(execution?.totals.filledSize ?? 0)} detail={`${formatUsd(execution?.totals.filledCostBasis ?? 0)} cost basis`} tone={(execution?.totals.filledSize ?? 0) > 0 ? 'good' : 'neutral'} />
        <SummaryCard icon={<RefreshCw size={18} />} label="This tick" value={`${execution?.totals.postedThisTick ?? 0}/${execution?.totals.cancelledThisTick ?? 0}`} detail="posted / cancelled" tone={insight.churnTone} />
      </section>

      <nav className="tabs" aria-label="Dashboard sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tabButton ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => selectTab(tab.id)}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'strategy' ? (
        <section className="strategyLayout tabPanel">
          <Panel
            title="Strategy Readout"
            subtitle="The current state translated into operator decisions."
            action={<Badge tone={insight.overallTone}>{insight.overallLabel}</Badge>}
          >
            <StrategyReadout state={state.data} insight={insight} />
          </Panel>
          <Panel title="Plan Quality" subtitle="Reward fit, min-size fit, and capital pressure across planned quotes.">
            <PlanQuality state={state.data} insight={insight} />
          </Panel>
        </section>
      ) : null}

      {activeTab === 'markets' ? (
        <section className="workspaceGrid tabPanel">
          <Panel title="Opportunity Queue" subtitle="Actionable markets first, then closest capital-fit misses by required funding and risk.">
            <MarketList candidates={rewards.candidates.slice(0, 10)} config={rewards.config} />
          </Panel>
          <Panel title="Quote Plans" subtitle="Current BUY YES / BUY NO plan set after reward min-size enforcement.">
            <QuotePlanList plans={rewards.quotePlans} candidates={rewards.candidates} />
          </Panel>
        </section>
      ) : null}

      {activeTab === 'orders' ? (
        <section className="workspaceGrid ordersGrid tabPanel">
          <Panel title="Active Orders" subtitle="Managed orders currently visible in CLOB open-order reconciliation.">
            <ActiveOrdersTable orders={execution?.activeOrders || []} />
          </Panel>
          <Panel title="Inventory And Fills" subtitle="Matched exposure from managed orders.">
            <InventoryAndFills inventory={execution?.inventory || []} fills={execution?.recentFills || []} />
          </Panel>
        </section>
      ) : null}

      {activeTab === 'risk' ? (
        <section className="workspaceGrid tabPanel">
          <Panel title="Guardrails" subtitle="Runtime constraints that decide whether a quote can be posted.">
            <RiskControls state={state.data} />
          </Panel>
          <Panel title="Risk Blocks" subtitle="Hard filters and market risk tags surfaced by the scanner.">
            <RiskBreakdown state={state.data} />
          </Panel>
        </section>
      ) : null}

      {activeTab === 'events' ? (
        <section className="workspaceGrid tabPanel">
          <Panel title="Execution Events" subtitle="Recent post, cancel, skip, and reconciliation decisions.">
            <ExecutionEvents events={execution?.recentEvents || []} />
          </Panel>
          <Panel title="Runtime Logs" subtitle="Worker diagnostics and scheduled tick summaries.">
            <RuntimeLogs logs={state.data.runtimeLogs.slice(0, 10)} diagnostics={rewards.diagnostics} />
          </Panel>
        </section>
      ) : null}
    </Shell>
  );
}

const tabs: Array<{ id: DashboardTab; label: string; icon: React.ReactNode }> = [
  { id: 'strategy', label: 'Strategy', icon: <Sparkles size={16} /> },
  { id: 'markets', label: 'Markets', icon: <Layers size={16} /> },
  { id: 'orders', label: 'Orders', icon: <ListChecks size={16} /> },
  { id: 'risk', label: 'Risk', icon: <ShieldQuestion size={16} /> },
  { id: 'events', label: 'Events', icon: <AlertTriangle size={16} /> },
];

const tabIds = new Set<DashboardTab>(tabs.map((tab) => tab.id));

function readTabFromUrl(): DashboardTab {
  const url = new URL(window.location.href);
  const tab = url.searchParams.get('tab') || url.hash.replace(/^#/, '');
  return isDashboardTab(tab) ? tab : 'strategy';
}

function writeTabToUrl(tab: DashboardTab) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  url.hash = '';
  window.history.pushState(null, '', url);
}

function isDashboardTab(value: string): value is DashboardTab {
  return tabIds.has(value as DashboardTab);
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="appShell">{children}</main>;
}

function SummaryCard({ icon, label, value, detail, tone = 'neutral' }: { icon: React.ReactNode; label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <article className={`summaryCard ${tone}`}>
      <div className="summaryIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function Panel({ title, subtitle, action, children }: { title: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {action ? <div className="panelAction">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function StrategyReadout({ state, insight }: { state: RewardsAppState; insight: StrategyInsight }) {
  const execution = state.execution;
  const rewards = state.rewards!;
  const rows = [
    {
      icon: insight.minSizeCompliantPlans === insight.eligiblePlans ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />,
      title: 'Rewards min-size fit',
      detail: `${insight.minSizeCompliantPlans}/${insight.eligiblePlans} planned quotes meet the market reward minimum size.`,
      tone: insight.minSizeTone,
    },
    {
      icon: <Gauge size={18} />,
      title: 'Capital pressure',
      detail: `${formatUsd(rewards.totals.plannedNotional)} planned against ${execution?.collateralBalance == null ? 'unknown' : formatUsd(execution.collateralBalance)} available collateral.`,
      tone: insight.capitalTone,
    },
    {
      icon: <RefreshCw size={18} />,
      title: 'Order churn',
      detail: `${execution?.totals.postedThisTick ?? 0} posted and ${execution?.totals.cancelledThisTick ?? 0} cancelled in the latest execution pass.`,
      tone: insight.churnTone,
    },
    {
      icon: <ShieldCheck size={18} />,
      title: 'Execution boundary',
      detail: execution?.mode === 'live'
        ? 'Live posting is enabled after credential, open-order, collateral, active-order, and inventory checks.'
        : 'Monitor mode is producing quote plans without posting live orders.',
      tone: insight.modeTone,
    },
  ];

  return (
    <div className="readoutList">
      {rows.map((row) => (
        <article className={`readoutItem ${row.tone}`} key={row.title}>
          <div className="readoutIcon">{row.icon}</div>
          <div>
            <h3>{row.title}</h3>
            <p>{row.detail}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function PlanQuality({ state, insight }: { state: RewardsAppState; insight: StrategyInsight }) {
  const rewards = state.rewards!;
  const execution = state.execution;
  const activeByLabel = groupOrdersByLabel(execution?.activeOrders || []);
  return (
    <div className="qualityGrid">
      <QualityMeter label="Eligible quotes" value={insight.eligiblePlans} total={rewards.quotePlans.length || 1} />
      <QualityMeter label="Min-size compliant" value={insight.minSizeCompliantPlans} total={Math.max(insight.eligiblePlans, 1)} tone={insight.minSizeTone} />
      <QualityMeter label="Active markets" value={new Set((execution?.activeOrders || []).map((order) => order.marketId)).size} total={rewards.config.maxOpenMarkets} />
      <div className="splitBox">
        <span>Outcome exposure</span>
        <strong>{activeByLabel.YES.count} YES / {activeByLabel.NO.count} NO</strong>
        <p>{formatUsd(activeByLabel.YES.notional)} YES notional, {formatUsd(activeByLabel.NO.notional)} NO notional.</p>
      </div>
    </div>
  );
}

function QualityMeter({ label, value, total, tone = 'neutral' }: { label: string; value: number; total: number; tone?: Tone }) {
  const pct = Math.min(100, Math.max(0, total ? (value / total) * 100 : 0));
  return (
    <div className={`qualityMeter ${tone}`}>
      <div>
        <span>{label}</span>
        <strong>{value}<small>/{total}</small></strong>
      </div>
      <div className="meterTrack" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MarketList({ candidates, config }: { candidates: RewardMarketCandidate[]; config: RewardsRuntimeConfig }) {
  if (!candidates.length) return <EmptyState title="No candidates" detail="No reward markets passed scanner ingestion yet." />;
  return (
    <div className="marketList">
      {candidates.map((market) => {
        const economics = quoteEconomics(market, config);
        return (
          <article className="marketRow" key={market.id}>
            <div className="marketMain">
              <div className="marketTitleLine">
                <h3>{market.question}</h3>
                {market.rejectReasons.length ? <Badge tone="bad">blocked</Badge> : <Badge tone="good">eligible</Badge>}
              </div>
              <p>{market.category || market.slug || shortId(market.conditionId || market.id)}</p>
              <TagList tags={market.riskTags} />
              {economics ? (
                <p className="fundingHint">
                  Reward-sized plan uses {formatShares(economics.minShares)} shares per side, estimated {formatUsd(economics.minTwoSidedCost)} total.
                </p>
              ) : null}
            </div>
            <div className="marketStats">
              <Stat label="Reward" value={formatUsd(market.dailyReward)} />
              <Stat label="Order size" value={formatShares(market.minSize)} />
              <Stat label="Min capital" value={economics ? formatUsd(economics.minTwoSidedCost) : '-'} />
              <Stat label="Max spread" value={formatCents(market.maxSpread)} />
              <Stat label="Mid" value={market.adjustedMidpoint == null ? '-' : market.adjustedMidpoint.toFixed(3)} />
              <Stat label="Net" value={market.netScore.toFixed(3)} tone={market.netScore > 0 ? 'good' : 'bad'} />
            </div>
            {market.rejectReasons.length ? <ReasonList reasons={market.rejectReasons} /> : null}
          </article>
        );
      })}
    </div>
  );
}

function QuotePlanList({ plans, candidates }: { plans: RewardQuotePlan[]; candidates: RewardMarketCandidate[] }) {
  const marketById = new Map(candidates.map((market) => [market.id, market]));
  const visible = plans.slice(0, 18);
  if (!visible.length) return <EmptyState title="No quote plans" detail="No opportunity currently passes min-size, spread, and risk controls." />;
  return (
    <div className="quoteList">
      {visible.map((plan) => {
        const market = marketById.get(plan.marketId);
        return (
          <article className={`quoteRow ${plan.eligible ? '' : 'muted'}`} key={plan.id}>
            <div>
              <div className="quoteTop">
                <Badge tone={plan.label === 'YES' ? 'good' : 'neutral'}>{plan.label} BUY</Badge>
                <Badge tone="good">reward-sized</Badge>
              </div>
              <p>{market?.question || shortId(plan.marketId)}</p>
            </div>
            <div className="quoteNumbers">
              <Stat label="Price" value={plan.price.toFixed(3)} />
              <Stat label="Size" value={formatShares(plan.size)} />
              <Stat label="Notional" value={formatUsd(plan.notional)} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ActiveOrdersTable({ orders }: { orders: RewardManagedOrder[] }) {
  if (!orders.length) return <EmptyState title="No active orders" detail="No managed orders are currently open." />;
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Outcome</th>
            <th>Price</th>
            <th>Open</th>
            <th>Filled</th>
            <th>Notional</th>
            <th>Age</th>
            <th>Order</th>
          </tr>
        </thead>
        <tbody>
          {orders.slice(0, 18).map((order) => (
            <tr key={order.orderId}>
              <td><Badge tone={order.label === 'YES' ? 'good' : 'neutral'}>{order.label}</Badge></td>
              <td className="mono">{order.price.toFixed(3)}</td>
              <td className="mono">{formatShares(order.remainingSize ?? order.size)}</td>
              <td className="mono">{formatShares(order.filledSize)}</td>
              <td className="mono">{formatUsd(order.price * (order.remainingSize ?? order.size))}</td>
              <td className="mono">{formatAge(order.createdAt)}</td>
              <td className="mono">{shortId(order.orderId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryAndFills({ inventory, fills }: { inventory: RewardInventorySummary[]; fills: RewardFillRecord[] }) {
  return (
    <div className="stackedPanel">
      <div className="miniSection">
        <h3>Inventory</h3>
        {inventory.length ? (
          <div className="miniRows">
            {inventory.slice(0, 8).map((row) => (
              <div className="miniRow" key={row.tokenId}>
                <span>{shortId(row.marketId)}</span>
                <strong>{row.label} {formatShares(row.openBuySize)} open</strong>
                <small>{formatShares(row.filledSize)} filled at {row.avgEntryPrice == null ? '-' : row.avgEntryPrice.toFixed(3)}</small>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No inventory" detail="No managed order fills have been recorded yet." />}
      </div>
      <div className="miniSection">
        <h3>Recent fills</h3>
        {fills.length ? (
          <div className="miniRows">
            {fills.slice(0, 8).map((fill) => (
              <div className="miniRow" key={fill.id}>
                <span>{formatTime(fill.createdAt)}</span>
                <strong>{fill.label} {formatShares(fill.size)} at {fill.price.toFixed(3)}</strong>
                <small>{formatUsd(fill.notional)} via {fill.source}</small>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No fills" detail="No match deltas or terminal reconciliations have been recorded." />}
      </div>
    </div>
  );
}

function RiskControls({ state }: { state: RewardsAppState }) {
  const config = state.rewards!.config;
  const rows = [
    ['Execution mode', state.execution?.mode || state.runtime.executionMode, state.execution?.mode === 'live' ? 'good' : 'neutral'],
    ['Global notional cap', formatUsd(config.maxGlobalNotional), 'neutral'],
    ['Per-market notional cap', formatUsd(config.maxMarketNotional), 'neutral'],
    ['Quote offset', config.quoteOffset.toFixed(3), 'neutral'],
    ['Min daily reward', formatUsd(config.minDailyReward), 'neutral'],
    ['Min time to close', `${Math.round(config.minSecondsToClose / 3600)}h`, 'neutral'],
    ['Drift review age', `${config.maxOrderAgeSeconds}s`, 'neutral'],
    ['Hard refresh age', `${config.maxOrderHardAgeSeconds}s`, config.maxOrderHardAgeSeconds < 600 ? 'warn' : 'neutral'],
    ['Orderbook max age', `${config.maxOrderbookAgeSeconds}s`, 'neutral'],
    ['Inventory cap / outcome', formatShares(config.maxInventorySharesPerOutcome), 'neutral'],
    ['Collateral reserve', formatUsd(config.minCollateralBalance), config.minCollateralBalance <= 0 ? 'warn' : 'neutral'],
    ['Max active / market', String(config.maxActiveOrdersPerMarket), 'neutral'],
  ] as Array<[string, string, Tone]>;

  return (
    <div className="controlGrid">
      {rows.map(([label, value, tone]) => (
        <div className={`controlRow ${tone}`} key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function RiskBreakdown({ state }: { state: RewardsAppState }) {
  const rewards = state.rewards!;
  const tagCounts = countStrings(rewards.candidates.flatMap((candidate) => candidate.riskTags));
  const reasonCounts = countStrings(rewards.candidates.flatMap((candidate) => candidate.rejectReasons));
  return (
    <div className="riskColumns">
      <RiskColumn title="Risk tags" items={tagCounts} empty="No risk tags emitted." />
      <RiskColumn title="Reject reasons" items={reasonCounts} empty="No hard reject reasons in the visible candidate set." />
      <div className="riskNote">
        <BarChart3 size={18} />
        <p>
          Minimum incentive size is now the order size. Each market is planned at its own reward min size,
          then rejected only if capital, notional, spread, or risk controls cannot support it.
        </p>
      </div>
    </div>
  );
}

function RiskColumn({ title, items, empty }: { title: string; items: Array<[string, number]>; empty: string }) {
  return (
    <div className="riskColumn">
      <h3>{title}</h3>
      {items.length ? items.slice(0, 10).map(([label, count]) => (
        <div className="riskRow" key={label}>
          <span>{label}</span>
          <strong>{count}</strong>
        </div>
      )) : <p className="mutedText">{empty}</p>}
    </div>
  );
}

function ExecutionEvents({ events }: { events: RewardExecutionEvent[] }) {
  if (!events.length) return <EmptyState title="No execution events" detail="Monitor mode does not post, cancel, or reconcile live orders." />;
  return (
    <div className="eventList">
      {events.slice(0, 14).map((event) => (
        <div className={`eventRow ${event.level}`} key={event.id}>
          <EventIcon event={event} />
          <span>{formatTime(event.createdAt)}</span>
          <p>{event.message}</p>
        </div>
      ))}
    </div>
  );
}

function RuntimeLogs({ logs, diagnostics }: { logs: RuntimeLogRecord[]; diagnostics: string[] }) {
  const rows = useMemo(() => [
    ...diagnostics.map((message) => ({ id: `diag-${message}`, level: 'warn' as const, createdAt: '', message })),
    ...logs,
  ].slice(0, 14), [logs, diagnostics]);
  if (!rows.length) return <EmptyState title="No logs" detail="The worker has not emitted diagnostics." />;
  return (
    <div className="eventList">
      {rows.map((log) => (
        <div className={`eventRow ${log.level}`} key={log.id}>
          <AlertTriangle size={15} />
          <span>{log.createdAt ? formatTime(log.createdAt) : 'diag'}</span>
          <p>{log.message}</p>
        </div>
      ))}
    </div>
  );
}

function EventIcon({ event }: { event: RewardExecutionEvent }) {
  if (event.action === 'post') return <CircleDot size={15} />;
  if (event.action === 'cancel') return <XCircle size={15} />;
  if (event.action === 'reconcile') return <CheckCircle2 size={15} />;
  return <AlertTriangle size={15} />;
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  return <div className="tagList">{tags.slice(0, 5).map((tag) => <Badge key={tag} tone={tagTone(tag)}>{tag}</Badge>)}</div>;
}

function ReasonList({ reasons }: { reasons: string[] }) {
  return (
    <div className="reasonList">
      {reasons.slice(0, 3).map((reason) => <Badge tone="bad" key={reason}>{reason}</Badge>)}
    </div>
  );
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: Tone }) {
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

type StrategyInsight = {
  eligiblePlans: number;
  minSizeCompliantPlans: number;
  minSizeTone: Tone;
  capitalTone: Tone;
  churnTone: Tone;
  exposureTone: Tone;
  modeTone: Tone;
  overallTone: Tone;
  overallLabel: string;
};

function buildStrategyInsight(state: RewardsAppState): StrategyInsight {
  const rewards = state.rewards!;
  const execution = state.execution;
  const marketById = new Map(rewards.candidates.map((market) => [market.id, market]));
  const eligiblePlans = rewards.quotePlans.filter((plan) => plan.eligible);
  const minSizeCompliantPlans = eligiblePlans.filter((plan) => plan.size >= (marketById.get(plan.marketId)?.minSize ?? 0)).length;
  const collateral = execution?.collateralBalance ?? 0;
  const plannedNotional = rewards.totals.plannedNotional;
  const minSizeTone: Tone = eligiblePlans.length === 0 || minSizeCompliantPlans === eligiblePlans.length ? 'good' : minSizeCompliantPlans === 0 ? 'bad' : 'warn';
  const capitalTone: Tone = execution?.mode === 'live' && collateral > 0 && plannedNotional > collateral ? 'warn' : 'good';
  const churn = (execution?.totals.postedThisTick ?? 0) + (execution?.totals.cancelledThisTick ?? 0);
  const churnTone: Tone = churn >= 6 ? 'warn' : 'neutral';
  const exposureTone: Tone = (execution?.totals.activeOrders ?? 0) > 0 ? 'good' : 'neutral';
  const modeTone: Tone = execution?.mode === 'live' ? 'good' : 'neutral';
  const overallTone: Tone = minSizeTone === 'bad' ? 'bad' : capitalTone === 'warn' || churnTone === 'warn' || minSizeTone === 'warn' ? 'warn' : 'good';
  const overallLabel = overallTone === 'good' ? 'healthy' : overallTone === 'warn' ? 'needs attention' : 'not reward-ready';
  return { eligiblePlans: eligiblePlans.length, minSizeCompliantPlans, minSizeTone, capitalTone, churnTone, exposureTone, modeTone, overallTone, overallLabel };
}

function groupOrdersByLabel(orders: RewardManagedOrder[]) {
  return orders.reduce((acc, order) => {
    const notional = order.price * (order.remainingSize ?? order.size);
    acc[order.label].count += 1;
    acc[order.label].notional += notional;
    return acc;
  }, { YES: { count: 0, notional: 0 }, NO: { count: 0, notional: 0 } });
}

function countStrings(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function tagTone(tag: string): Tone {
  if (/good|low-competition|wide|eligible|low-min/.test(tag)) return 'good';
  if (/missing|near|live|crypto|breaking|ambiguous|thin|high/.test(tag)) return 'warn';
  return 'neutral';
}

function quoteEconomics(market: RewardMarketCandidate, config: RewardsRuntimeConfig) {
  if (market.adjustedMidpoint == null) return null;
  const offset = Math.max(config.quoteOffset, (market.marketSpread ?? 0) / 2);
  const yesPrice = roundPrice(market.adjustedMidpoint - offset);
  const noPrice = roundPrice(1 - market.adjustedMidpoint - offset);
  if (yesPrice <= 0.01 || yesPrice >= 0.99 || noPrice <= 0.01 || noPrice >= 0.99) return null;
  const pairCostPerShare = yesPrice + noPrice;
  const minShares = Math.max(market.minSize, 0);
  return {
    yesPrice,
    noPrice,
    minShares,
    minTwoSidedCost: roundMoney(minShares * pairCostPerShare),
  };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number) {
  return Math.round(value * 1000) / 1000;
}

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function formatShares(value: number) {
  return value.toFixed(value >= 100 ? 0 : 2);
}

function formatCents(value: number) {
  return value ? `${(value * 100).toFixed(1)}c` : '-';
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatAge(value: string) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(ageSeconds)) return '-';
  if (ageSeconds < 60) return `${ageSeconds}s`;
  return `${Math.floor(ageSeconds / 60)}m ${ageSeconds % 60}s`;
}

function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}
