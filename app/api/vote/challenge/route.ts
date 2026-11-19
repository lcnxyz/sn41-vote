import { NextResponse, type NextRequest } from 'next/server';
import { resolveVoteTarget } from '@/lib/castVote';
import { createVoteChallenge } from '@/lib/challenge';
import { getChallengeStore } from '@/lib/challengeStore';
import { getConfig } from '@/lib/config';
import { getQuestions } from '@/lib/questions';
import { getVoteStore } from '@/lib/sqliteVoteStore';
import { normalizeAddress } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

function error(status: number, message: string) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const address = normalizeAddress(params.get('address'));
  if (!address) return error(400, 'Invalid or missing address: expected an SS58-encoded address');

  const target = resolveVoteTarget(getQuestions(), params.get('questionId'), params.get('optionId'));
  if (!target.ok) return error(target.status, target.reason);

  if (await getVoteStore().get(target.question.id, address)) {
    return error(409, 'This address has already voted on this question');
  }

  const config = getConfig();
  const challenge = await createVoteChallenge({
    address,
    appDomain: config.appDomain,
    ttlSeconds: config.challengeTtlSeconds,
    store: getChallengeStore(),
    questionId: target.question.id,
    questionTitle: target.question.title,
    optionId: target.option.id,
    optionLabel: target.option.label,
  });

  return NextResponse.json({ message: challenge.message }, { headers: noStore });
}
