import { formatRao } from './tao';
import { questionStatus, type Question, type QuestionStatus } from './questions';
import type { Vote } from './voteStore';

export interface OptionTally {
  id: string;
  label: string;
  /** Sum of the alpha snapshots cast for this option, in raw chain units. */
  alpha: bigint;
  votes: number;
  /** Share of the question's total alpha in basis points (1/100 of a percent), rounded down. */
  shareBps: number;
}

export interface QuestionTally {
  totalAlpha: bigint;
  totalVotes: number;
  options: OptionTally[];
}

/**
 * Weighted tally: each vote counts for the alpha stored with it. Integer math throughout; the
 * share is `option alpha / total alpha`. Votes for an option that is not on the question are
 * ignored. Options with no votes show zero.
 */
export function tallyQuestion(question: Pick<Question, 'id' | 'options'>, votes: readonly Vote[]): QuestionTally {
  const options = new Map<string, OptionTally>(
    question.options.map((option) => [option.id, { ...option, alpha: 0n, votes: 0, shareBps: 0 }]),
  );

  let totalAlpha = 0n;
  let totalVotes = 0;
  for (const vote of votes) {
    if (vote.questionId !== question.id) continue;
    const option = options.get(vote.optionId);
    if (!option) continue;
    const alpha = BigInt(vote.alpha);
    option.alpha += alpha;
    option.votes += 1;
    totalAlpha += alpha;
    totalVotes += 1;
  }

  const tallies = [...options.values()];
  if (totalAlpha > 0n) {
    for (const option of tallies) option.shareBps = Number((option.alpha * 10_000n) / totalAlpha);
  }
  return { totalAlpha, totalVotes, options: tallies };
}

/** 3333 -> "33.33". */
export function formatBps(bps: number): string {
  return (bps / 100).toFixed(2);
}

export interface BallotVote {
  address: string;
  optionId: string;
  alpha: string;
  votedAt: string;
}

export interface BallotOption {
  id: string;
  label: string;
  alpha: string;
  votes: number;
  sharePercent: string;
}

export interface BallotQuestion {
  id: string;
  title: string;
  body: string;
  opensAt: string;
  closesAt: string;
  status: QuestionStatus;
  totalAlpha: string;
  totalVotes: number;
  options: BallotOption[];
  votes: BallotVote[];
}

/** The public view: every question with its status, weighted tally and full vote list. */
export function buildBallot(questions: readonly Question[], votes: readonly Vote[], now = Date.now()): BallotQuestion[] {
  return questions.map((question) => {
    const tally = tallyQuestion(question, votes);
    const own = votes.filter(
      (vote) => vote.questionId === question.id && question.options.some((option) => option.id === vote.optionId),
    );
    return {
      id: question.id,
      title: question.title,
      body: question.body,
      opensAt: question.opensAt,
      closesAt: question.closesAt,
      status: questionStatus(question, now),
      totalAlpha: formatRao(tally.totalAlpha),
      totalVotes: tally.totalVotes,
      options: tally.options.map((option) => ({
        id: option.id,
        label: option.label,
        alpha: formatRao(option.alpha),
        votes: option.votes,
        sharePercent: formatBps(option.shareBps),
      })),
      votes: own.map((vote) => ({
        address: vote.address,
        optionId: vote.optionId,
        alpha: formatRao(BigInt(vote.alpha)),
        votedAt: vote.votedAt,
      })),
    };
  });
}
