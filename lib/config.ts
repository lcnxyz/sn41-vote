export interface AppConfig {
  rpcUrl: string;
  appDomain: string;
  challengeTtlSeconds: number;
}

const DEFAULT_RPC_URL = 'wss://test.finney.opentensor.ai:443';

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const rpcUrl = process.env.BITTENSOR_RPC_URL?.trim() || DEFAULT_RPC_URL;
  if (!/^wss?:\/\//.test(rpcUrl)) {
    throw new Error(`BITTENSOR_RPC_URL must start with ws:// or wss:// (got "${rpcUrl}")`);
  }

  const appDomain = process.env.APP_DOMAIN?.trim() || 'localhost:3000';

  const ttlRaw = process.env.CHALLENGE_TTL_SECONDS?.trim() || '300';
  const challengeTtlSeconds = Number(ttlRaw);
  if (!Number.isInteger(challengeTtlSeconds) || challengeTtlSeconds <= 0) {
    throw new Error(`CHALLENGE_TTL_SECONDS must be a positive integer (got "${ttlRaw}")`);
  }

  cached = { rpcUrl, appDomain, challengeTtlSeconds };
  return cached;
}
