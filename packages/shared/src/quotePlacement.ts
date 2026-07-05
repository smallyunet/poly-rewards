export const DEFENSIVE_QUOTE_SPREAD_RATIO = 0.85;

export function defensiveQuoteOffset(params: { marketSpread: number | null; maxSpread: number }): number {
  const maxSpread = Number.isFinite(params.maxSpread) ? Math.max(params.maxSpread, 0) : 0;
  if (maxSpread <= 0) return 0;

  const halfMarketSpread = Number.isFinite(params.marketSpread) ? Math.max(params.marketSpread ?? 0, 0) / 2 : 0;
  const defensiveOffset = maxSpread * DEFENSIVE_QUOTE_SPREAD_RATIO;
  return roundPrice(Math.min(Math.max(halfMarketSpread, defensiveOffset), maxSpread));
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
}
