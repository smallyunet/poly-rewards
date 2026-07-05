import { loadRewardsAppConfig } from './rewardsConfig';
import { runRewardsTick } from './rewards';
import { createServer } from './server';
import { RewardsStore } from './rewardsStore';

async function main() {
  const config = loadRewardsAppConfig();
  const store = new RewardsStore(config.tickIntervalMs, { maxRecords: config.runtimeMaxRecords });

  let tickRunning = false;
  const tick = async (source: 'initial' | 'scheduled' | 'manual') => {
    if (tickRunning) {
      store.recordRuntimeLog({ level: 'warn', source: 'worker', message: `Skipped ${source} tick because a previous tick is still running.` });
      return;
    }
    tickRunning = true;
    try {
      const snapshot = await runRewardsTick(config);
      store.recordRewardsSnapshot(snapshot);
      store.markRunningIfDegraded();
      store.recordRuntimeLog({
        level: snapshot.diagnostics.some((item) => /failed|stale|blocked|error/i.test(item)) ? 'warn' : 'info',
        source: 'worker',
        message: `${source} tick completed.`,
        details: { marketsScanned: snapshot.marketsScanned, plannedOrders: snapshot.totals.plannedOrders, diagnostics: snapshot.diagnostics },
      });
      console.log('[api] rewards tick', JSON.stringify({ source, updatedAt: snapshot.updatedAt, marketsScanned: snapshot.marketsScanned, candidates: snapshot.candidates.length, plannedOrders: snapshot.totals.plannedOrders }));
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
