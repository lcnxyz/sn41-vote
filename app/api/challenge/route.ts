import { NextResponse, type NextRequest } from 'next/server';
import { createChallenge } from '@/lib/challenge';
import { getChallengeStore } from '@/lib/challengeStore';
import { getConfig } from '@/lib/config';
import { normalizeAddress } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const address = normalizeAddress(request.nextUrl.searchParams.get('address'));
  if (!address) {
    return NextResponse.json(
      { error: 'Invalid or missing address: expected an SS58-encoded address' },
      { status: 400, headers: noStore },
    );
  }

  const config = getConfig();
  const challenge = await createChallenge({
    address,
    appDomain: config.appDomain,
    ttlSeconds: config.challengeTtlSeconds,
    store: getChallengeStore(),
  });

  return NextResponse.json({ message: challenge.message }, { headers: noStore });
}
