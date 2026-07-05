import WebSocket from 'ws';

import type { RewardOrderbookSummary } from '../../../packages/shared/src';
import type { RewardsAppConfig } from './rewardsConfig';

type StreamBook = Omit<RewardOrderbookSummary, 'label'>;

export class OrderbookStream {
  private socket?: WebSocket;
  private readonly desiredTokenIds = new Set<string>();
  private readonly subscribedTokenIds = new Set<string>();
  private readonly books = new Map<string, StreamBook>();
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;

  constructor(private readonly appConfig: RewardsAppConfig) {}

  syncTokenIds(tokenIds: string[]): void {
    const next = new Set(tokenIds.map((tokenId) => tokenId.trim()).filter(Boolean));
    const toSubscribe = [...next].filter((tokenId) => !this.subscribedTokenIds.has(tokenId));
    const toUnsubscribe = [...this.subscribedTokenIds].filter((tokenId) => !next.has(tokenId));
    this.desiredTokenIds.clear();
    for (const tokenId of next) this.desiredTokenIds.add(tokenId);

    for (const tokenId of toUnsubscribe) {
      this.subscribedTokenIds.delete(tokenId);
      this.books.delete(tokenId);
    }

    if (!this.desiredTokenIds.size) {
      this.close();
      return;
    }

    if (!this.socket || this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) {
      this.connect();
      return;
    }

    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (toSubscribe.length) this.send({ operation: 'subscribe', assets_ids: toSubscribe, level: 2, custom_feature_enabled: true });
    if (toUnsubscribe.length) this.send({ operation: 'unsubscribe', assets_ids: toUnsubscribe });
    for (const tokenId of toSubscribe) this.subscribedTokenIds.add(tokenId);
  }

  getOrderbook(tokenId: string, label: RewardOrderbookSummary['label']): RewardOrderbookSummary | undefined {
    const book = this.books.get(tokenId);
    return book ? { ...book, label } : undefined;
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
    this.subscribedTokenIds.clear();
    this.socket?.close();
    this.socket = undefined;
  }

  private connect(): void {
    if (!this.desiredTokenIds.size) return;
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;

    this.socket = new WebSocket(this.appConfig.clobWsUrl);
    this.socket.on('open', () => {
      this.reconnectAttempts = 0;
      this.subscribedTokenIds.clear();
      const tokenIds = [...this.desiredTokenIds];
      this.send({ assets_ids: tokenIds, type: 'market', initial_dump: true, level: 2, custom_feature_enabled: true });
      for (const tokenId of tokenIds) this.subscribedTokenIds.add(tokenId);
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send('PING'), 10_000);
    });
    this.socket.on('message', (data) => this.handleMessage(data.toString()));
    this.socket.on('close', () => this.scheduleReconnect());
    this.socket.on('error', () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.subscribedTokenIds.clear();
    if (!this.desiredTokenIds.size || this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    if (!raw || raw === 'PONG') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) this.applyMessage(message);
  }

  private applyMessage(message: unknown): void {
    if (!isRecord(message)) return;
    const eventType = String(message.event_type || '');
    if (eventType === 'book') {
      const tokenId = stringValue(message.asset_id);
      if (!tokenId) return;
      const bids = readLevels(message.bids);
      const asks = readLevels(message.asks);
      this.books.set(tokenId, summaryFromLevels(tokenId, bids, asks, message));
      return;
    }
    if (eventType === 'best_bid_ask') {
      const tokenId = stringValue(message.asset_id);
      if (!tokenId) return;
      const bestBid = finiteNumber(message.best_bid);
      const bestAsk = finiteNumber(message.best_ask);
      const existing = this.books.get(tokenId);
      this.books.set(tokenId, {
        tokenId,
        bestBid,
        bestAsk,
        midpoint: bestBid != null && bestAsk != null ? roundPrice((bestBid + bestAsk) / 2) : existing?.midpoint ?? null,
        spread: finiteNumber(message.spread) ?? (bestBid != null && bestAsk != null ? roundPrice(bestAsk - bestBid) : existing?.spread ?? null),
        bidDepth: existing?.bidDepth ?? 0,
        askDepth: existing?.askDepth ?? 0,
        updatedAt: timestampIso(message.timestamp),
      });
    }
  }
}

function summaryFromLevels(tokenId: string, bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>, raw: Record<string, unknown>): StreamBook {
  const bestBid = bids.length ? Math.max(...bids.map((level) => level.price)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map((level) => level.price)) : null;
  return {
    tokenId,
    bestBid,
    bestAsk,
    midpoint: bestBid != null && bestAsk != null ? roundPrice((bestBid + bestAsk) / 2) : null,
    spread: bestBid != null && bestAsk != null ? roundPrice(bestAsk - bestBid) : null,
    bidDepth: roundShares(sum(bids.map((level) => level.size))),
    askDepth: roundShares(sum(asks.map((level) => level.size))),
    updatedAt: timestampIso(raw.timestamp),
  };
}

function readLevels(value: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) return null;
    const price = finiteNumber(item.price);
    const size = finiteNumber(item.size);
    return price != null && size != null ? { price, size } : null;
  }).filter((item): item is { price: number; size: number } => Boolean(item));
}

function timestampIso(value: unknown): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  return new Date().toISOString();
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundShares(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number): number {
  return Math.round(value * 1000) / 1000;
}
