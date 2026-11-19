export const TAO_DECIMALS = 9;
export const RAO_PER_TAO = 1_000_000_000n;

/** Formats a RAO amount as an exact TAO decimal string, e.g. 1500000000n -> "1.5". */
export function formatRao(rao: bigint): string {
  const negative = rao < 0n;
  const abs = negative ? -rao : rao;
  const whole = abs / RAO_PER_TAO;
  const frac = (abs % RAO_PER_TAO).toString().padStart(TAO_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parses a non-negative TAO decimal string (max 9 decimals) into RAO without floating point. */
export function parseTaoToRao(tao: string): bigint {
  const value = tao.trim();
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid TAO amount "${tao}": expected a non-negative number with at most 9 decimals`);
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? '').padEnd(TAO_DECIMALS, '0'));
  return whole * RAO_PER_TAO + frac;
}
