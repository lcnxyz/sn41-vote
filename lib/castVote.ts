import { ChainError } from './chain';
import type { ChallengeStore } from './challengeStore';
import { holdsSubnetAlpha } from './balance';
import { questionStatus, type Question, type QuestionOption } from './questions';
import { verifyChallenge } from './verifyChallenge';
import { normalizeAddress } from './validation';
import type { Vote, VoteStore } from './voteStore';

export type CastVoteResult =
  | { ok: true; vote: Vote }
  | { ok: false; status: 400 | 401 | 403 | 409 | 503 | 504 | 500; reason: string; signatureVerified?: true };

export type VoteTarget =
  | { ok: true; question: Question; option: QuestionOption }
  | { ok: false; status: 400; reason: string };

/** Finds the question and option and checks that the question is open right now. */
export function resolveVoteTarget(
  questions: readonly Question[],
  questionId: unknown,
  optionId: unknown,
  now = Date.now(),
): VoteTarget {
  if (typeof questionId !== 'string' || typeof optionId !== 'string' || !questionId || !optionId) {
    return { ok: false, status: 400, reason: 'questionId and optionId are required' };
  }
  const question = questions.find((item) => item.id === questionId);
  if (!question) return { ok: false, status: 400, reason: 'Unknown question' };
  const option = question.options.find((item) => item.id === optionId);
  if (!option) return { ok: false, status: 400, reason: 'Unknown option for this question' };
  const status = questionStatus(question, now);
  if (status !== 'open') {
    return { ok: false, status: 400, reason: `This question is not open for voting (it is ${status})` };
  }
  return { ok: true, question, option };
}

export interface CastVoteParams {
  address: unknown;
  signature: unknown;
  questionId: unknown;
  optionId: unknown;
  questions: readonly Question[];
  challenges: ChallengeStore;
  votes: VoteStore;
  /** Current SN41 alpha for a coldkey, in raw chain units. */
  readAlpha: (address: string) => Promise<bigint>;
  now?: number;
}

/**
 * Records one locked vote. The alpha stored is read at this moment and never changes afterwards.
 *
 * Order matters: everything that can be checked without spending the single-use challenge is
 * checked first (target, open window, existing vote), then the signature, then the chain read.
 */
export async function castVote({
  address: rawAddress,
  signature,
  questionId,
  optionId,
  questions,
  challenges,
  votes,
  readAlpha,
  now = Date.now(),
}: CastVoteParams): Promise<CastVoteResult> {
  const address = normalizeAddress(rawAddress);
  if (!address) {
    return { ok: false, status: 400, reason: 'Invalid address: expected an SS58-encoded address' };
  }

  const target = resolveVoteTarget(questions, questionId, optionId, now);
  if (!target.ok) return target;
  const { question, option } = target;

  if (await votes.get(question.id, address)) {
    return { ok: false, status: 409, reason: 'This address has already voted on this question' };
  }

  const proof = await verifyChallenge({
    address,
    signature,
    store: challenges,
    now,
    expected: { purpose: 'vote', questionId: question.id, optionId: option.id },
  });
  if (!proof.ok) return proof;

  let alpha: bigint;
  try {
    alpha = await readAlpha(address);
  } catch (err) {
    if (err instanceof ChainError) {
      return {
        ok: false,
        status: err.code === 'timeout' ? 504 : 503,
        reason: err.message,
        signatureVerified: true,
      };
    }
    console.error('Unexpected error while checking SN41 alpha for a vote', err);
    return { ok: false, status: 500, reason: 'Unexpected error while checking SN41 alpha', signatureVerified: true };
  }

  if (!holdsSubnetAlpha(alpha)) {
    return { ok: false, status: 403, reason: 'This address holds no SN41 alpha, so it cannot vote' };
  }

  const vote: Vote = {
    questionId: question.id,
    address,
    optionId: option.id,
    alpha: alpha.toString(),
    votedAt: new Date(now).toISOString(),
  };
  if ((await votes.insert(vote)) === 'duplicate') {
    return { ok: false, status: 409, reason: 'This address has already voted on this question' };
  }
  return { ok: true, vote };
}
