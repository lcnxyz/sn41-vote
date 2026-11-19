import { NextResponse } from 'next/server';
import { getQuestions } from '@/lib/questions';
import { getVoteStore } from '@/lib/sqliteVoteStore';
import { buildBallot } from '@/lib/tally';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const votes = await getVoteStore().list();
  return NextResponse.json(
    { questions: buildBallot(getQuestions(), votes), serverTime: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
