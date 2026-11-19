import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createChallenge } from '../lib/challenge';
import { MemoryChallengeStore } from '../lib/challengeStore';
import { alphaOnSubnet, holdsSubnetAlpha } from '../lib/balance';
import { formatRao, parseTaoToRao } from '../lib/tao';
import { verifyChallenge } from '../lib/verifyChallenge';

const TTL_SECONDS = 300;

let alice: KeyringPair;
let bob: KeyringPair;
let store: MemoryChallengeStore;

beforeAll(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
});

beforeEach(() => {
  store = new MemoryChallengeStore();
});

async function issue(address: string, now = Date.now()) {
  return createChallenge({ address, appDomain: 'test.local', ttlSeconds: TTL_SECONDS, store, now });
}

/** Signs the way browser extensions do: `<Bytes>message</Bytes>`. */
function signWrapped(pair: KeyringPair, message: string) {
  return u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(message))));
}

describe('verifyChallenge', () => {
  it('builds the expected human-readable message', async () => {
    const { message } = await issue(alice.address);
    expect(message).toMatch(/^Sign in to test\.local\n/);
    expect(message).toContain('It does not authorize any transaction.');
    expect(message).toContain(`Address: ${alice.address}`);
    expect(message).toMatch(/Nonce: [0-9a-f]{32}/);
    expect(message).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
  });

  it('accepts a <Bytes>-wrapped sr25519 signature (browser wallet format)', async () => {
    const { message } = await issue(alice.address);
    const result = await verifyChallenge({ address: alice.address, signature: signWrapped(alice, message), store });
    expect(result).toEqual({ ok: true, address: alice.address });
  });

  it('accepts a signature over the unwrapped message', async () => {
    const { message } = await issue(alice.address);
    const signature = u8aToHex(alice.sign(stringToU8a(message)));
    const result = await verifyChallenge({ address: alice.address, signature, store });
    expect(result.ok).toBe(true);
  });

  it('rejects replaying the same signature', async () => {
    const { message } = await issue(alice.address);
    const signature = signWrapped(alice, message);
    expect((await verifyChallenge({ address: alice.address, signature, store })).ok).toBe(true);
    const replay = await verifyChallenge({ address: alice.address, signature, store });
    expect(replay).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/No challenge/) });
  });

  it('consumes the challenge even when the signature is invalid', async () => {
    const { message } = await issue(alice.address);
    await verifyChallenge({ address: alice.address, signature: signWrapped(bob, message), store });
    const retry = await verifyChallenge({ address: alice.address, signature: signWrapped(alice, message), store });
    expect(retry).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/No challenge/) });
  });

  it('rejects an expired challenge', async () => {
    const issuedAt = Date.now();
    const { message } = await issue(alice.address, issuedAt);
    const result = await verifyChallenge({
      address: alice.address,
      signature: signWrapped(alice, message),
      store,
      now: issuedAt + TTL_SECONDS * 1000 + 1,
    });
    expect(result).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/expired/) });
  });

  it('rejects a signature from a different key', async () => {
    const { message } = await issue(alice.address);
    const result = await verifyChallenge({ address: alice.address, signature: signWrapped(bob, message), store });
    expect(result).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/Invalid signature/) });
  });

  it('rejects a signature over a different message', async () => {
    await issue(alice.address);
    const result = await verifyChallenge({
      address: alice.address,
      signature: signWrapped(alice, 'some other message'),
      store,
    });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts the same key given in a different SS58 format', async () => {
    const polkadotFormat = new Keyring({ type: 'sr25519', ss58Format: 0 }).addFromUri('//Alice').address;
    const { message } = await issue(alice.address);
    const result = await verifyChallenge({ address: polkadotFormat, signature: signWrapped(alice, message), store });
    expect(result).toEqual({ ok: true, address: alice.address });
  });

  it.each([
    ['empty address', '', '0x' + '00'.repeat(64)],
    ['garbage address', 'not-an-address', '0x' + '00'.repeat(64)],
    ['hex address', '0x' + '11'.repeat(32), '0x' + '00'.repeat(64)],
    ['non-string address', 123, '0x' + '00'.repeat(64)],
  ])('returns 400 for %s', async (_label, address, signature) => {
    const result = await verifyChallenge({ address, signature, store });
    expect(result).toMatchObject({ ok: false, status: 400, reason: expect.stringMatching(/address/i) });
  });

  it.each([
    ['missing 0x', '00'.repeat(64)],
    ['too short', '0x' + '00'.repeat(32)],
    ['non-hex', '0x' + 'zz'.repeat(64)],
    ['non-string', 42],
  ])('returns 400 for signature %s', async (_label, signature) => {
    await issue(alice.address);
    const result = await verifyChallenge({ address: alice.address, signature, store });
    expect(result).toMatchObject({ ok: false, status: 400, reason: expect.stringMatching(/signature/i) });
    expect(await store.get(alice.address)).toBeDefined();
  });
});

describe('TAO / RAO conversion', () => {
  it('formats RAO exactly', () => {
    expect(formatRao(0n)).toBe('0');
    expect(formatRao(1n)).toBe('0.000000001');
    expect(formatRao(1_000_000_000n)).toBe('1');
    expect(formatRao(1_500_000_000n)).toBe('1.5');
    expect(formatRao(21_000_000_000_000_000n)).toBe('21000000');
  });

  it('parses TAO strings without floating point error', () => {
    expect(parseTaoToRao('1')).toBe(1_000_000_000n);
    expect(parseTaoToRao('0.1')).toBe(100_000_000n);
    expect(parseTaoToRao('0.000000001')).toBe(1n);
    expect(parseTaoToRao('123.456789012')).toBe(123_456_789_012n);
  });

  it('rejects invalid TAO strings', () => {
    for (const bad of ['', '-1', '1.0000000001', 'abc', '1e9']) {
      expect(() => parseTaoToRao(bad)).toThrow();
    }
  });

  it('compares amounts with BigInt precision', () => {
    expect(parseTaoToRao('0.000000001')).toBe(1n);
    expect(holdsSubnetAlpha(0n)).toBe(false);
    expect(holdsSubnetAlpha(1n)).toBe(true);
  });
});

describe('SN41 alpha', () => {
  const stakes = [
    { netuid: 41, alpha: 1n },
    { netuid: 41, alpha: 500_000_000n },
    { netuid: 1, alpha: 9_000_000_000n },
    { netuid: 18, alpha: 1n },
  ];

  it('sums every hotkey on subnet 41 and ignores other subnets', () => {
    expect(alphaOnSubnet(stakes, 41)).toBe(500_000_001n);
  });

  it('fails only when the subnet total is zero', () => {
    expect(holdsSubnetAlpha(alphaOnSubnet(stakes, 41))).toBe(true);
    expect(holdsSubnetAlpha(alphaOnSubnet(stakes, 7))).toBe(false);
    expect(holdsSubnetAlpha(alphaOnSubnet([], 41))).toBe(false);
  });
});
