import type { RewardsAppState, RewardsDashboardState, RewardsRuntimeStatus, RuntimeLogRecord } from '../../../packages/shared/src';

type RewardsStoreOptions = {
  maxRecords?: number;
};

export class RewardsStore {
  private runtime: RewardsRuntimeStatus;
  private rewards?: RewardsDashboardState;
  private runtimeLogs: RuntimeLogRecord[] = [];
  private readonly maxRecords: number;

  constructor(private readonly tickIntervalMs: number, options: RewardsStoreOptions = {}) {
    const startedAt = new Date();
    this.maxRecords = options.maxRecords ?? 1_000;
    this.runtime = {
      status: 'running',
      executionMode: 'monitor',
      startedAt: startedAt.toISOString(),
      nextTickAt: new Date(startedAt.getTime() + tickIntervalMs).toISOString(),
      tickIntervalMs,
      version: runtimeVersion(),
      buildSha: optionalEnv('GIT_SHA') || optionalEnv('BUILD_SHA'),
      buildTime: optionalEnv('BUILD_TIME'),
      dockerReady: true,
      strategy: 'polymarket_rewards_market_making',
    };
  }

  getRuntime(): RewardsRuntimeStatus {
    return this.runtime;
  }

  markDegraded(): RewardsRuntimeStatus {
    this.runtime = { ...this.runtime, status: 'degraded' };
    return this.runtime;
  }

  markRunningIfDegraded(): RewardsRuntimeStatus {
    if (this.runtime.status !== 'degraded') return this.runtime;
    this.runtime = { ...this.runtime, status: 'running' };
    return this.runtime;
  }

  recordRewardsSnapshot(snapshot: RewardsDashboardState): void {
    this.rewards = snapshot;
    const capturedAtMs = new Date(snapshot.updatedAt).getTime();
    this.runtime = {
      ...this.runtime,
      lastTickAt: snapshot.updatedAt,
      nextTickAt: new Date(capturedAtMs + this.tickIntervalMs).toISOString(),
    };
  }

  recordRuntimeLog(log: Omit<RuntimeLogRecord, 'id' | 'createdAt'> & { createdAt?: string }): void {
    const createdAt = log.createdAt || new Date().toISOString();
    this.runtimeLogs = [{
      id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAt,
      ...log,
    }, ...this.runtimeLogs].slice(0, this.maxRecords);
  }

  dashboardState(): RewardsAppState {
    return {
      runtime: this.runtime,
      rewards: this.rewards,
      runtimeLogs: this.runtimeLogs,
    };
  }
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function runtimeVersion(): string {
  return optionalEnv('APP_VERSION') || '0.1.0';
}
