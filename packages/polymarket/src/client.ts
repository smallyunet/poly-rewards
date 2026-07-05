import { Wallet } from '@ethersproject/wallet';
import type { TradeSide } from '../../shared/src';

export type PolymarketClientConfig = {
  clobApiUrl: string;
  dataApiUrl?: string;
  chainId: number;
  ownerPrivateKey?: string;
  depositWallet?: string;
};

export type RewardLimitIntent = {
  id: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  label: 'YES' | 'NO';
  side: TradeSide;
  limitPrice: number;
  shares: number;
  reason: string;
  createdAt: string;
};

export type LimitOrderResult = {
  ok: boolean;
  orderId?: string;
  price: number;
  size: number;
  raw?: unknown;
  error?: string;
};

export type OpenOrderSummary = {
  id: string;
  tokenId: string;
  side: string;
  price: number | null;
  size: number | null;
  sizeMatched: number | null;
  status: string;
  raw: unknown;
};

export type CollateralBalanceAllowance = {
  balance: number;
  allowance: number | null;
};

type ClobModule = {
  ClobClient: new (params: Record<string, unknown>) => any;
  Side: { BUY: unknown; SELL: unknown };
  OrderType: { GTC: unknown; GTD: unknown; FAK: unknown };
  AssetType: { COLLATERAL: unknown; CONDITIONAL: unknown };
};

async function importClobClient(): Promise<ClobModule> {
  return import('@polymarket/clob-client-v2') as unknown as ClobModule;
}

export class PolymarketAdapter {
  constructor(private readonly config: PolymarketClientConfig) {}

  async executeRewardLimitIntent(intent: RewardLimitIntent, options: { execute: boolean; orderType?: 'GTC' | 'GTD' | 'FAK'; expiration?: number }): Promise<LimitOrderResult> {
    if (!options.execute) {
      return { ok: true, price: intent.limitPrice, size: roundDownShares(intent.shares), raw: { dryRun: true, intent } };
    }
    if (!this.config.ownerPrivateKey?.trim()) throw new Error('OWNER_PRIVATE_KEY is required for execution.');
    if (!this.config.depositWallet?.trim()) throw new Error('POLYMARKET_DEPOSIT_WALLET is required for execution.');

    const { OrderType, Side } = await importClobClient();
    const client = await this.authenticatedClient();
    const [tickSize, negRisk] = await Promise.all([client.getTickSize(intent.tokenId), client.getNegRisk(intent.tokenId)]);
    const size = roundDownShares(intent.shares);
    const signedOrder = await client.createOrder(
      {
        tokenID: intent.tokenId,
        price: intent.limitPrice,
        side: intent.side === 'BUY' ? Side.BUY : Side.SELL,
        size,
        ...(options.orderType === 'GTD' && options.expiration ? { expiration: options.expiration } : {}),
      },
      { tickSize, negRisk },
    );
    const posted = await client.postOrder(signedOrder, clobOrderType(OrderType, options.orderType));
    const error = orderError(posted);
    return {
      ok: !error,
      orderId: typeof posted?.orderID === 'string' ? posted.orderID : typeof posted?.orderId === 'string' ? posted.orderId : undefined,
      price: intent.limitPrice,
      size,
      raw: posted,
      error,
    };
  }

  async getOpenOrders(params: { tokenId?: string } = {}): Promise<OpenOrderSummary[]> {
    const client = await this.authenticatedClient();
    const orders = await client.getOpenOrders(params.tokenId ? { asset_id: params.tokenId } : undefined, true);
    if (!Array.isArray(orders)) return [];
    return orders.map((order: any) => ({
      id: String(order.id || order.orderID || order.orderId || order.order_id || ''),
      tokenId: String(order.asset_id || order.token_id || order.tokenID || order.tokenId || ''),
      side: String(order.side || '').toUpperCase(),
      price: finiteNumber(order.price),
      size: finiteNumber(order.original_size ?? order.size),
      sizeMatched: finiteNumber(order.size_matched ?? order.matched_size ?? order.sizeMatched),
      status: String(order.status || ''),
      raw: order,
    }));
  }

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    const ids = orderIds.map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return { cancelled: [] };
    const client = await this.authenticatedClient();
    return client.cancelOrders(ids);
  }

  async getAvailableShares(tokenId: string): Promise<number> {
    if (!tokenId.trim()) throw new Error('tokenId is required for balance reads.');
    const { AssetType } = await importClobClient();
    const client = await this.authenticatedClient();
    const response = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return Number(readBalanceRaw(response)) / 1_000_000;
  }

  async getCollateralBalanceAllowance(): Promise<CollateralBalanceAllowance> {
    const { AssetType } = await importClobClient();
    const client = await this.authenticatedClient();
    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    return {
      balance: Number(readBalanceRaw(response)) / 1_000_000,
      allowance: readMinAllowance(response),
    };
  }

  private async authenticatedClient(): Promise<any> {
    const ownerPrivateKey = this.config.ownerPrivateKey?.trim();
    const depositWallet = this.config.depositWallet?.trim();
    if (!ownerPrivateKey) throw new Error('OWNER_PRIVATE_KEY is required for authenticated CLOB calls.');
    if (!depositWallet) throw new Error('POLYMARKET_DEPOSIT_WALLET is required for authenticated CLOB calls.');

    const { ClobClient } = await importClobClient();
    const signer = new Wallet(ownerPrivateKey);
    const signerClient = new ClobClient({
      host: this.config.clobApiUrl,
      chain: this.config.chainId,
      signer,
      signatureType: 3,
      funderAddress: depositWallet,
      useServerTime: true,
    });
    const apiCreds = await this.resolveApiCreds(signerClient);
    return new ClobClient({
      host: this.config.clobApiUrl,
      chain: this.config.chainId,
      signer,
      creds: apiCreds,
      signatureType: 3,
      funderAddress: depositWallet,
      useServerTime: true,
    });
  }

  private async resolveApiCreds(client: any): Promise<unknown> {
    const resolved = await client.createOrDeriveApiKey?.().catch(() => undefined);
    if (resolved?.key && resolved?.secret && resolved?.passphrase) return resolved;
    const derived = await client.deriveApiKey?.().catch(() => undefined);
    if (derived?.key && derived?.secret && derived?.passphrase) return derived;
    throw new Error('Failed to resolve Polymarket CLOB API credentials.');
  }
}

function clobOrderType(OrderType: ClobModule['OrderType'], orderType: 'GTC' | 'GTD' | 'FAK' = 'GTC'): unknown {
  if (orderType === 'FAK') return OrderType.FAK;
  if (orderType === 'GTD') return OrderType.GTD;
  return OrderType.GTC;
}

function roundDownShares(value: number): number {
  return Math.floor(value * 100) / 100;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function orderError(posted: any): string | undefined {
  if (typeof posted?.error === 'string' && posted.error.trim()) return posted.error;
  if (typeof posted?.errorMsg === 'string' && posted.errorMsg.trim()) return posted.errorMsg;
  if (posted?.success === false) return 'CLOB rejected order.';
  return undefined;
}

function readBalanceRaw(response: any): string {
  return String(response?.balance || response?.balances?.[0]?.balance || response?.available || '0');
}

function readMinAllowance(response: any): number | null {
  const allowances = response?.allowances;
  if (!allowances || typeof allowances !== 'object') return null;
  const values = Object.values(allowances)
    .map((value) => Number(value) / 1_000_000)
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return Math.min(...values);
}
