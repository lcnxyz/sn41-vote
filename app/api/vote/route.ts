import { NextResponse, type NextRequest } from 'next/server';
import { getSubnetAlpha } from '@/lib/balance';
import { castVote } from '@/lib/castVote';
import { getChallengeStore } from '@/lib/challengeStore';
import { getQuestions } from '@/lib/questions';
import { getVoteStore } from '@/lib/sqliteVoteStore';
import { formatRao } from '@/lib/tao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };
const BODY_HELP = 'Request body must be JSON: { address, signature, questionId, optionId }';

function error(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ voted: false, error: message, ...extra }, { status, headers: noStore });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, BODY_HELP);
  }
  if (!body || typeof body !== 'object') return error(400, BODY_HELP);
  const { address, signature, questionId, optionId } = body as Record<string, unknown>;

  const result = await castVote({
    address,
    signature,
    questionId,
    optionId,
    questions: getQuestions(),
    challenges: getChallengeStore(),
    votes: getVoteStore(),
    readAlpha: (coldkey) => getSubnetAlpha(coldkey),
  });

  if (!result.ok) {
    return error(result.status, result.reason, result.signatureVerified ? { signatureVerified: true } : {});
  }

  const { vote } = result;
  return NextResponse.json(
    {
      voted: true,
      vote: {
        questionId: vote.questionId,
        address: vote.address,
        optionId: vote.optionId,
        alpha: formatRao(BigInt(vote.alpha)),
        votedAt: vote.votedAt,
      },
    },
    { status: 201, headers: noStore },
  );
}
