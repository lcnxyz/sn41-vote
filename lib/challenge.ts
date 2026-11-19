import { randomBytes } from 'node:crypto';
import type { ChallengeStore, StoredChallenge } from './challengeStore';

export interface BuildMessageParams {
  appDomain: string;
  address: string;
  nonce: string;
  expiresAt: Date;
}

export function buildMessage({ appDomain, address, nonce, expiresAt }: BuildMessageParams): string {
  return [
    `Sign in to ${appDomain}`,
    'This signature only proves you own this address. It does not authorize any transaction.',
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join('\n');
}

export interface CreateChallengeParams {
  address: string;
  appDomain: string;
  ttlSeconds: number;
  store: ChallengeStore;
  now?: number;
}

/** Creates and stores a fresh challenge for an already-normalized address. */
export async function createChallenge({
  address,
  appDomain,
  ttlSeconds,
  store,
  now = Date.now(),
}: CreateChallengeParams): Promise<StoredChallenge> {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = now + ttlSeconds * 1000;
  const message = buildMessage({ appDomain, address, nonce, expiresAt: new Date(expiresAt) });
  const challenge: StoredChallenge = { address, message, expiresAt };
  await store.set(challenge);
  return challenge;
}

export interface BuildVoteMessageParams extends BuildMessageParams {
  questionId: string;
  questionTitle: string;
  optionId: string;
  optionLabel: string;
}

export function buildVoteMessage({
  appDomain,
  address,
  nonce,
  expiresAt,
  questionId,
  questionTitle,
  optionId,
  optionLabel,
}: BuildVoteMessageParams): string {
  return [
    `Vote on ${appDomain}`,
    'This signature only records your vote. It does not authorize any transaction.',
    `Question: ${questionTitle} (${questionId})`,
    `Option: ${optionLabel} (${optionId})`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join('\n');
}

export interface CreateVoteChallengeParams extends CreateChallengeParams {
  questionId: string;
  questionTitle: string;
  optionId: string;
  optionLabel: string;
}

/** Creates and stores a single-use challenge that names one question and one option. */
export async function createVoteChallenge({
  address,
  appDomain,
  ttlSeconds,
  store,
  now = Date.now(),
  questionId,
  questionTitle,
  optionId,
  optionLabel,
}: CreateVoteChallengeParams): Promise<StoredChallenge> {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = now + ttlSeconds * 1000;
  const message = buildVoteMessage({
    appDomain,
    address,
    nonce,
    expiresAt: new Date(expiresAt),
    questionId,
    questionTitle,
    optionId,
    optionLabel,
  });
  const challenge: StoredChallenge = { address, message, expiresAt, purpose: 'vote', questionId, optionId };
  await store.set(challenge);
  return challenge;
}
