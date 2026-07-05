import { loadRewardsAppConfig } from './rewardsConfig';
import { RewardsExecutionService } from './rewardsExecution';
import { runRewardsTick } from './rewards';
import { createServer } from './server';
import { RewardsStore } from './rewardsStore';
import { OrderbookStream } from './orderbookStream';

async function main() {
  const config = loadRewardsAppConfig();
  const store = new RewardsStore(config.tickIntervalMs, config.executionMode, { maxRecords: config.runtimeMaxRecords });
  const execution = new RewardsExecutionService(config);
  const orderbookStream = new OrderbookStream(config);

  let tickRunning = false;
  const tick = async (source: 'initial' | 'scheduled' | 'manual') => {
    if (tickRunning) {
      store.recordRuntimeLog({ level: 'warn', source: 'worker', message: `Skipped ${source} tick because a previous tick is still running.` });
      return;
    }
    tickRunning = true;
    try {
      const snapshot = await runRewardsTick(config, orderbookStream);
      store.recordRewardsSnapshot(snapshot);
      const executionState = await execution.reconcile(snapshot);
      store.recordExecutionState(executionState);
      orderbookStream.syncTokenIds([
        ...snapshot.quotePlans.filter((plan) => plan.eligible).map((plan) => plan.tokenId),
        ...executionState.activeOrders.map((order) => order.tokenId),
      ]);
      store.markRunningIfDegraded();
      store.recordRuntimeLog({
        level: snapshot.diagnostics.some((item) => /failed|stale|blocked|error/i.test(item)) || executionState.recentEvents.some((event) => event.level === 'error') ? 'warn' : 'info',
        source: 'worker',
        message: `${source} tick completed.`,
        details: {
          marketsScanned: snapshot.marketsScanned,
          plannedOrders: snapshot.totals.plannedOrders,
          execution: executionState.totals,
          diagnostics: snapshot.diagnostics,
        },
      });
      console.log('[api] rewards tick', JSON.stringify({
        source,
        updatedAt: snapshot.updatedAt,
        marketsScanned: snapshot.marketsScanned,
        candidates: snapshot.candidates.length,
        plannedOrders: snapshot.totals.plannedOrders,
        execution: executionState.totals,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.markDegraded();
      store.recordRuntimeLog({ level: 'error', source: 'worker', message: `${source} tick failed: ${message}` });
      console.warn(`[api] ${source} tick failed`, message);
    } finally {
      tickRunning = false;
    }
  };

  await tick('initial');
  setInterval(() => void tick('scheduled'), config.tickIntervalMs);
  const app = createServer(config, store, () => tick('manual'));
  app.listen(config.port, () => {
    console.log(`[api] listening on :${config.port}`);
  });
}

void main().catch((error) => {
  console.error('[api] fatal', error);
  process.exit(1);
});
