import { ApiPromise, WsProvider } from '@polkadot/api';
import { getConfig } from './config';

export const CONNECT_TIMEOUT_MS = 15_000;
export const QUERY_TIMEOUT_MS = 10_000;

export type ChainErrorCode = 'timeout' | 'unavailable';

export class ChainError extends Error {
  constructor(
    public readonly code: ChainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChainError('timeout', message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const globalForApi = globalThis as unknown as { __bittensorApi?: Promise<ApiPromise> };

async function connect(rpcUrl: string): Promise<ApiPromise> {
  const provider = new WsProvider(rpcUrl, 2_500, {}, CONNECT_TIMEOUT_MS);
  try {
    const api = await withTimeout(
      ApiPromise.create({ provider, throwOnConnect: true, noInitWarn: true }),
      CONNECT_TIMEOUT_MS,
      `Timed out connecting to Bittensor RPC at ${rpcUrl}`,
    );
    const reset = () => {
      globalForApi.__bittensorApi = undefined;
      api.off('disconnected', reset);
      api.off('error', reset);
      // Stop the old provider's auto-reconnect loop; the next request opens a fresh connection.
      api.disconnect().catch(() => {});
    };
    api.on('disconnected', reset);
    api.on('error', reset);
    return api;
  } catch (err) {
    await provider.disconnect().catch(() => {});
    if (err instanceof ChainError) throw err;
    throw new ChainError('unavailable', `Could not connect to Bittensor RPC at ${rpcUrl}: ${describeError(err)}`);
  }
}

/** WebSocket failures surface as ErrorEvent objects rather than Errors. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const { message, error } = err as { message?: unknown; error?: unknown };
    if (typeof message === 'string' && message) return message;
    if (error instanceof Error) return error.message;
  }
  return 'connection failed';
}

/** Shared lazy ApiPromise. Cleared on failure or disconnect so the next call reconnects. */
export function getApi(): Promise<ApiPromise> {
  if (!globalForApi.__bittensorApi) {
    const pending = connect(getConfig().rpcUrl);
    globalForApi.__bittensorApi = pending;
    pending.catch(() => {
      if (globalForApi.__bittensorApi === pending) globalForApi.__bittensorApi = undefined;
    });
  }
  return globalForApi.__bittensorApi;
}
