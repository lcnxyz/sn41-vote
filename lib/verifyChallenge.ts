import type { ChallengePurpose, ChallengeStore } from './challengeStore';
import { verifyMessageSignature } from './signature';
import { isValidSignatureHex, normalizeAddress } from './validation';

export type VerifyChallengeResult =
  | { ok: true; address: string }
  | { ok: false; status: 400 | 401; reason: string };

/** What the stored challenge must have been issued for. Defaults to a plain sign-in. */
export interface ExpectedChallenge {
  purpose: ChallengePurpose;
  questionId?: string;
  optionId?: string;
}

export interface VerifyChallengeParams {
  address: unknown;
  signature: unknown;
  store: ChallengeStore;
  now?: number;
  expected?: ExpectedChallenge;
}

/** Proves address ownership against a stored single-use challenge. Does not touch the chain. */
export async function verifyChallenge({
  address: rawAddress,
  signature,
  store,
  now = Date.now(),
  expected = { purpose: 'sign-in' },
}: VerifyChallengeParams): Promise<VerifyChallengeResult> {
  const address = normalizeAddress(rawAddress);
  if (!address) {
    return { ok: false, status: 400, reason: 'Invalid address: expected an SS58-encoded address' };
  }
  if (!isValidSignatureHex(signature)) {
    return { ok: false, status: 400, reason: 'Invalid signature: expected a 0x-prefixed hex signature' };
  }

  const challenge = await store.take(address);
  if (!challenge) {
    return { ok: false, status: 401, reason: 'No challenge found for this address. Request a new one.' };
  }
  if (challenge.expiresAt <= now) {
    return { ok: false, status: 401, reason: 'Challenge expired. Request a new one.' };
  }

  // The challenge is already consumed, so a mismatched purpose or target cannot be retried.
  if (
    (challenge.purpose ?? 'sign-in') !== expected.purpose ||
    challenge.questionId !== expected.questionId ||
    challenge.optionId !== expected.optionId
  ) {
    return { ok: false, status: 401, reason: 'This challenge was issued for a different action. Request a new one.' };
  }

  const valid = await verifyMessageSignature(challenge.message, signature, address);
  if (!valid) {
    return { ok: false, status: 401, reason: 'Invalid signature for this address and challenge.' };
  }

  return { ok: true, address };
}
