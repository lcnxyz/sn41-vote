import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

export const BITTENSOR_SS58_PREFIX = 42;

const MAX_ADDRESS_LENGTH = 64;

/**
 * Validates an SS58 address and re-encodes it with the Bittensor prefix (42), so the same
 * public key always maps to the same canonical string. Returns null if invalid.
 */
export function normalizeAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value || value.length > MAX_ADDRESS_LENGTH || value.startsWith('0x')) return null;
  try {
    const publicKey = decodeAddress(value);
    if (publicKey.length !== 32) return null;
    return encodeAddress(publicKey, BITTENSOR_SS58_PREFIX);
  } catch {
    return null;
  }
}

/** 64 bytes (sr25519/ed25519) up to 66 bytes (MultiSignature-prefixed ecdsa). */
export function isValidSignatureHex(input: unknown): input is `0x${string}` {
  return typeof input === 'string' && /^0x(?:[0-9a-fA-F]{2}){64,66}$/.test(input);
}
