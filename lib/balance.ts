import { ChainError, QUERY_TIMEOUT_MS, describeError, getApi, withTimeout } from './chain';

export { RAO_PER_TAO, formatRao, parseTaoToRao } from './tao';

/** Subnet 41. Alpha uses the same 9-decimal precision as TAO (1 alpha = 1e9). */
export const SUBNET_NETUID = 41;

export interface StakePosition {
  netuid: number;
  /** Alpha staked to one hotkey, in raw chain units. */
  alpha: bigint;
}

/** Sums alpha staked on one subnet. Stake on every other subnet is ignored. */
export function alphaOnSubnet(stakes: readonly StakePosition[], netuid: number): bigint {
  let total = 0n;
  for (const stake of stakes) {
    if (stake.netuid === netuid) total += stake.alpha;
  }
  return total;
}

/** Passes when the wallet holds any SN alpha. Zero is the only failure. */
export function holdsSubnetAlpha(alpha: bigint): boolean {
  return alpha > 0n;
}

interface StakeInfoCodec {
  netuid: { toNumber(): number };
  stake: { toBigInt(): bigint };
}

interface StakeInfoCall {
  stakeInfoRuntimeApi: {
    getStakeInfoForColdkey: (coldkey: string) => Promise<StakeInfoCodec[]>;
  };
}

/**
 * Total alpha the coldkey has staked on a subnet, across every hotkey.
 * Read-only: `StakeInfoRuntimeApi.get_stake_info_for_coldkey`. AlphaV2 stores shares, not balances.
 */
export async function getSubnetAlpha(address: string, netuid = SUBNET_NETUID): Promise<bigint> {
  const api = await getApi();
  try {
    const infos = await withTimeout(
      (api.call as unknown as StakeInfoCall).stakeInfoRuntimeApi.getStakeInfoForColdkey(address),
      QUERY_TIMEOUT_MS,
      `Timed out reading SN${netuid} alpha from the Bittensor chain`,
    );
    return alphaOnSubnet(
      infos.map((info) => ({ netuid: info.netuid.toNumber(), alpha: info.stake.toBigInt() })),
      netuid,
    );
  } catch (err) {
    if (err instanceof ChainError) throw err;
    throw new ChainError('unavailable', `Failed to read SN${netuid} alpha: ${describeError(err)}`);
  }
}
