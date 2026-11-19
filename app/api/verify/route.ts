import { NextResponse, type NextRequest } from 'next/server';
import { SUBNET_NETUID, formatRao, getSubnetAlpha, holdsSubnetAlpha } from '@/lib/balance';
import { ChainError } from '@/lib/chain';
import { getChallengeStore } from '@/lib/challengeStore';
import { verifyChallenge } from '@/lib/verifyChallenge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

function error(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ verified: false, error: message, ...extra }, { status, headers: noStore });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, 'Request body must be JSON: { address, signature }');
  }
  if (!body || typeof body !== 'object') {
    return error(400, 'Request body must be JSON: { address, signature }');
  }
  const { address, signature } = body as Record<string, unknown>;

  const result = await verifyChallenge({ address, signature, store: getChallengeStore() });
  if (!result.ok) {
    return error(result.status, result.reason);
  }

  try {
    const alpha = await getSubnetAlpha(result.address, SUBNET_NETUID);
    return NextResponse.json(
      {
        verified: true,
        address: result.address,
        netuid: SUBNET_NETUID,
        alpha: formatRao(alpha),
        passes: holdsSubnetAlpha(alpha),
      },
      { headers: noStore },
    );
  } catch (err) {
    if (err instanceof ChainError) {
      return error(err.code === 'timeout' ? 504 : 503, err.message, { signatureVerified: true });
    }
    console.error('Unexpected error while checking SN41 alpha', err);
    return error(500, 'Unexpected error while checking SN41 alpha', { signatureVerified: true });
  }
}
