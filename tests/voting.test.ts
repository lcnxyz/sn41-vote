import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { castVote, resolveVoteTarget } from '../lib/castVote';
import { ChainError } from '../lib/chain';
import { createChallenge, createVoteChallenge } from '../lib/challenge';
import { MemoryChallengeStore } from '../lib/challengeStore';
import { getQuestions, parseQuestions, questionStatus, type Question } from '../lib/questions';
import { SqliteVoteStore } from '../lib/sqliteVoteStore';
import { buildBallot, formatBps, tallyQuestion } from '../lib/tally';
import { MemoryVoteStore, type Vote, type VoteStore } from '../lib/voteStore';
import { verifyChallenge } from '../lib/verifyChallenge';

const OPENS = '2026-01-01T00:00:00Z';
const CLOSES = '2026-02-01T00:00:00Z';
const DURING = Date.parse('2026-01-15T00:00:00Z');
const TTL_SECONDS = 300;

const question: Question = {
  id: 'q1',
  title: 'Pick one',
  body: '',
  opensAt: OPENS,
  closesAt: CLOSES,
  options: [
    { id: 'a', label: 'Option A' },
    { id: 'b', label: 'Option B' },
    { id: 'c', label: 'Option C' },
  ],
};

let alice: KeyringPair;
let bob: KeyringPair;
let challenges: MemoryChallengeStore;
let votes: MemoryVoteStore;

beforeAll(async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
  alice = keyring.addFromUri('//Alice');
  bob = keyring.addFromUri('//Bob');
});

beforeEach(() => {
  challenges = new MemoryChallengeStore();
  votes = new MemoryVoteStore();
});

function sign(pair: KeyringPair, message: string) {
  return u8aToHex(pair.sign(u8aWrapBytes(stringToU8a(message))));
}

function readerFor(alpha: bigint) {
  return async () => alpha;
}

async function issueVote(pair: KeyringPair, optionId = 'a', now = DURING) {
  return createVoteChallenge({
    address: pair.address,
    appDomain: 'test.local',
    ttlSeconds: TTL_SECONDS,
    store: challenges,
    now,
    questionId: question.id,
    questionTitle: question.title,
    optionId,
    optionLabel: question.options.find((option) => option.id === optionId)?.label ?? optionId,
  });
}

/** Issues a vote challenge, signs it, and casts the vote in one go. */
async function vote(
  pair: KeyringPair,
  {
    optionId = 'a',
    alpha = 1_000_000_000n,
    now = DURING,
    store = votes as VoteStore,
  }: { optionId?: string; alpha?: bigint | (() => Promise<bigint>); now?: number; store?: VoteStore } = {},
) {
  const { message } = await issueVote(pair, optionId, now);
  return castVote({
    address: pair.address,
    signature: sign(pair, message),
    questionId: question.id,
    optionId,
    questions: [question],
    challenges,
    votes: store,
    readAlpha: typeof alpha === 'function' ? alpha : readerFor(alpha),
    now,
  });
}

describe('question file', () => {
  it('ships a valid committed questions file', () => {
    const questions = getQuestions();
    expect(questions.length).toBeGreaterThan(0);
    for (const item of questions) expect(item.options.length).toBeGreaterThanOrEqual(2);
  });

  const valid = {
    id: 'q',
    title: 'T',
    opensAt: OPENS,
    closesAt: CLOSES,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  };

  it('accepts a minimal question and normalizes dates', () => {
    const [parsed] = parseQuestions([valid]);
    expect(parsed.opensAt).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.body).toBe('');
  });

  it.each([
    ['not an array', {}],
    ['duplicate question ids', [valid, valid]],
    ['close not after open', [{ ...valid, closesAt: OPENS }]],
    ['close before open', [{ ...valid, closesAt: '2025-01-01T00:00:00Z' }]],
    ['bad date', [{ ...valid, opensAt: 'soon' }]],
    ['one option', [{ ...valid, options: [{ id: 'a', label: 'A' }] }]],
    [
      'duplicate option ids',
      [{ ...valid, options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
    ],
    ['option without label', [{ ...valid, options: [{ id: 'a', label: 'A' }, { id: 'b' }] }]],
    ['bad id characters', [{ ...valid, id: 'has space' }]],
    ['missing title', [{ ...valid, title: ' ' }]],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseQuestions(raw)).toThrow(/Invalid questions file/);
  });
});

describe('question status', () => {
  const open = Date.parse(OPENS);
  const close = Date.parse(CLOSES);

  it('is upcoming before opensAt, open from opensAt, and closed at closesAt', () => {
    expect(questionStatus(question, open - 1)).toBe('upcoming');
    expect(questionStatus(question, open)).toBe('open');
    expect(questionStatus(question, close - 1)).toBe('open');
    expect(questionStatus(question, close)).toBe('closed');
    expect(questionStatus(question, close + 1)).toBe('closed');
  });

  it('only accepts votes for an open question and a known option', () => {
    expect(resolveVoteTarget([question], 'q1', 'a', DURING).ok).toBe(true);
    expect(resolveVoteTarget([question], 'q1', 'a', open - 1)).toMatchObject({ ok: false, reason: /upcoming/ });
    expect(resolveVoteTarget([question], 'q1', 'a', close)).toMatchObject({ ok: false, reason: /closed/ });
    expect(resolveVoteTarget([question], 'q1', 'zzz', DURING)).toMatchObject({ ok: false, reason: /option/ });
    expect(resolveVoteTarget([question], 'nope', 'a', DURING)).toMatchObject({ ok: false, reason: /question/ });
    expect(resolveVoteTarget([question], 1, 'a', DURING)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('weighted tally', () => {
  const cast = (address: string, optionId: string, alpha: bigint): Vote => ({
    questionId: 'q1',
    address,
    optionId,
    alpha: alpha.toString(),
    votedAt: '2026-01-02T00:00:00.000Z',
  });

  it('weights each vote by its alpha, not by head count', () => {
    const tally = tallyQuestion(question, [
      cast('w1', 'a', 1_000_000_000n),
      cast('w2', 'a', 2_000_000_000n),
      cast('w3', 'b', 7_000_000_000n),
    ]);
    const byId = Object.fromEntries(tally.options.map((option) => [option.id, option]));
    expect(byId.a).toMatchObject({ alpha: 3_000_000_000n, votes: 2, shareBps: 3000 });
    expect(byId.b).toMatchObject({ alpha: 7_000_000_000n, votes: 1, shareBps: 7000 });
    expect(byId.c).toMatchObject({ alpha: 0n, votes: 0, shareBps: 0 });
    expect(tally.totalAlpha).toBe(10_000_000_000n);
    expect(tally.totalVotes).toBe(3);
  });

  it('shows zero for everything when there are no votes', () => {
    const tally = tallyQuestion(question, []);
    expect(tally.totalAlpha).toBe(0n);
    expect(tally.options.every((option) => option.shareBps === 0 && option.alpha === 0n)).toBe(true);
  });

  it('keeps exact integer precision on large and tiny alpha', () => {
    const big = 21_000_000_000_000_000n;
    const tally = tallyQuestion(question, [cast('w1', 'a', big), cast('w2', 'b', 1n)]);
    expect(tally.options[0].alpha).toBe(big);
    expect(tally.totalAlpha).toBe(big + 1n);
    expect(tally.options[0].shareBps).toBe(9999);
    expect(tally.options[1].shareBps).toBe(0);
  });

  it('ignores votes for other questions and unknown options', () => {
    const tally = tallyQuestion(question, [
      { ...cast('w1', 'a', 5n), questionId: 'other' },
      cast('w2', 'unknown', 5n),
      cast('w3', 'a', 1n),
    ]);
    expect(tally.totalAlpha).toBe(1n);
    expect(tally.totalVotes).toBe(1);
  });

  it('formats basis points as a percentage', () => {
    expect(formatBps(3333)).toBe('33.33');
    expect(formatBps(10_000)).toBe('100.00');
    expect(formatBps(0)).toBe('0.00');
  });

  it('builds the public ballot with status, weights and the full vote list', () => {
    const [entry] = buildBallot(
      [question],
      [cast('w1', 'a', 1_500_000_000n), cast('w2', 'b', 500_000_000n)],
      DURING,
    );
    expect(entry.status).toBe('open');
    expect(entry.totalAlpha).toBe('2');
    expect(entry.options.map((option) => [option.id, option.alpha, option.sharePercent])).toEqual([
      ['a', '1.5', '75.00'],
      ['b', '0.5', '25.00'],
      ['c', '0', '0.00'],
    ]);
    expect(entry.votes).toEqual([
      { address: 'w1', optionId: 'a', alpha: '1.5', votedAt: '2026-01-02T00:00:00.000Z' },
      { address: 'w2', optionId: 'b', alpha: '0.5', votedAt: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  it('still shows tallies for closed and upcoming questions', () => {
    const afterClose = Date.parse(CLOSES) + 1;
    const [closed] = buildBallot([question], [cast('w1', 'a', 1_000_000_000n)], afterClose);
    expect(closed.status).toBe('closed');
    expect(closed.totalAlpha).toBe('1');
  });
});

describe('castVote', () => {
  it('stores the alpha read at vote time, normalized address and timestamp', async () => {
    const result = await vote(alice, { optionId: 'b', alpha: 2_500_000_000n });
    expect(result).toEqual({
      ok: true,
      vote: {
        questionId: 'q1',
        address: alice.address,
        optionId: 'b',
        alpha: '2500000000',
        votedAt: new Date(DURING).toISOString(),
      },
    });
    expect(await votes.get('q1', alice.address)).toMatchObject({ optionId: 'b', alpha: '2500000000' });
  });

  it('locks the vote: a second vote on the same question is rejected and changes nothing', async () => {
    expect((await vote(alice, { optionId: 'a', alpha: 1_000_000_000n })).ok).toBe(true);
    const second = await vote(alice, { optionId: 'b', alpha: 9_000_000_000n });
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(await votes.list()).toHaveLength(1);
    expect(await votes.get('q1', alice.address)).toMatchObject({ optionId: 'a', alpha: '1000000000' });
  });

  it('does not spend the challenge or read the chain for an address that already voted', async () => {
    await vote(alice);
    const { message } = await issueVote(alice, 'b');
    let reads = 0;
    const result = await castVote({
      address: alice.address,
      signature: sign(alice, message),
      questionId: 'q1',
      optionId: 'b',
      questions: [question],
      challenges,
      votes,
      readAlpha: async () => {
        reads += 1;
        return 1n;
      },
      now: DURING,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(reads).toBe(0);
    expect(await challenges.get(alice.address)).toBeDefined();
  });

  it('lets different wallets vote on the same question', async () => {
    expect((await vote(alice, { optionId: 'a' })).ok).toBe(true);
    expect((await vote(bob, { optionId: 'b' })).ok).toBe(true);
    expect(await votes.list()).toHaveLength(2);
  });

  it('rejects a vote when the wallet holds zero alpha', async () => {
    const result = await vote(alice, { alpha: 0n });
    expect(result).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/no SN41 alpha/) });
    expect(await votes.list()).toHaveLength(0);
  });

  it('rejects a vote for an unknown option without consuming the challenge', async () => {
    const { message } = await issueVote(alice, 'a');
    const result = await castVote({
      address: alice.address,
      signature: sign(alice, message),
      questionId: 'q1',
      optionId: 'zzz',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1n),
      now: DURING,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await challenges.get(alice.address)).toBeDefined();
  });

  it('rejects votes before the question opens and at or after it closes', async () => {
    const early = await vote(alice, { now: Date.parse(OPENS) - 1 });
    expect(early).toMatchObject({ ok: false, status: 400, reason: expect.stringMatching(/upcoming/) });
    const late = await vote(alice, { now: Date.parse(CLOSES) });
    expect(late).toMatchObject({ ok: false, status: 400, reason: expect.stringMatching(/closed/) });
    expect(await votes.list()).toHaveLength(0);
  });

  it('rejects a sign-in signature replayed as a vote', async () => {
    const signIn = await createChallenge({
      address: alice.address,
      appDomain: 'test.local',
      ttlSeconds: TTL_SECONDS,
      store: challenges,
      now: DURING,
    });
    const result = await castVote({
      address: alice.address,
      signature: sign(alice, signIn.message),
      questionId: 'q1',
      optionId: 'a',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1_000_000_000n),
      now: DURING,
    });
    expect(result).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/different action/) });
    expect(await votes.list()).toHaveLength(0);
  });

  it('rejects a vote signature used to sign in', async () => {
    const { message } = await issueVote(alice, 'a');
    const result = await verifyChallenge({ address: alice.address, signature: sign(alice, message), store: challenges, now: DURING });
    expect(result).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/different action/) });
  });

  it('rejects a signature for one option when the request names another', async () => {
    const { message } = await issueVote(alice, 'a');
    const result = await castVote({
      address: alice.address,
      signature: sign(alice, message),
      questionId: 'q1',
      optionId: 'b',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1_000_000_000n),
      now: DURING,
    });
    expect(result).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/different action/) });
    expect(await votes.list()).toHaveLength(0);
  });

  it('rejects a signature made by another key', async () => {
    const { message } = await issueVote(alice, 'a');
    const result = await castVote({
      address: alice.address,
      signature: sign(bob, message),
      questionId: 'q1',
      optionId: 'a',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1_000_000_000n),
      now: DURING,
    });
    expect(result).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/Invalid signature/) });
    expect(await votes.list()).toHaveLength(0);
  });

  it('rejects a replayed vote signature', async () => {
    const { message } = await issueVote(alice, 'a');
    const signature = sign(alice, message);
    const params = {
      address: alice.address,
      signature,
      questionId: 'q1',
      optionId: 'a',
      questions: [question],
      challenges,
      readAlpha: readerFor(1_000_000_000n),
      now: DURING,
    };
    expect((await castVote({ ...params, votes })).ok).toBe(true);
    // Fresh store: a replay must fail on the consumed challenge, not just on the duplicate check.
    const replay = await castVote({ ...params, votes: new MemoryVoteStore() });
    expect(replay).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/No challenge/) });
  });

  it('rejects an expired vote challenge', async () => {
    const { message } = await issueVote(alice, 'a', DURING);
    const result = await castVote({
      address: alice.address,
      signature: sign(alice, message),
      questionId: 'q1',
      optionId: 'a',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1n),
      now: DURING + TTL_SECONDS * 1000 + 1,
    });
    expect(result).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/expired/) });
  });

  it('rejects a malformed address and signature with 400', async () => {
    const badAddress = await castVote({
      address: 'nope',
      signature: '0x' + '00'.repeat(64),
      questionId: 'q1',
      optionId: 'a',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1n),
      now: DURING,
    });
    expect(badAddress).toMatchObject({ ok: false, status: 400 });

    await issueVote(alice, 'a');
    const badSignature = await castVote({
      address: alice.address,
      signature: 'not-hex',
      questionId: 'q1',
      optionId: 'a',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1n),
      now: DURING,
    });
    expect(badSignature).toMatchObject({ ok: false, status: 400, reason: expect.stringMatching(/signature/i) });
  });

  it('reports chain failures after the signature was verified, and stores nothing', async () => {
    const down = await vote(alice, {
      alpha: async () => {
        throw new ChainError('unavailable', 'rpc down');
      },
    });
    expect(down).toMatchObject({ ok: false, status: 503, signatureVerified: true });

    const slow = await vote(alice, {
      alpha: async () => {
        throw new ChainError('timeout', 'too slow');
      },
    });
    expect(slow).toMatchObject({ ok: false, status: 504, signatureVerified: true });

    const odd = await vote(alice, {
      alpha: async () => {
        throw new Error('boom');
      },
    });
    expect(odd).toMatchObject({ ok: false, status: 500, signatureVerified: true });
    expect(await votes.list()).toHaveLength(0);
  });

  it('treats the same key in another SS58 format as the same voter', async () => {
    const polkadotFormat = new Keyring({ type: 'sr25519', ss58Format: 0 }).addFromUri('//Alice').address;
    const { message } = await issueVote(alice, 'a');
    const result = await castVote({
      address: polkadotFormat,
      signature: sign(alice, message),
      questionId: 'q1',
      optionId: 'a',
      questions: [question],
      challenges,
      votes,
      readAlpha: readerFor(1n),
      now: DURING,
    });
    expect(result).toMatchObject({ ok: true, vote: { address: alice.address } });
  });
});

describe('vote challenge message', () => {
  it('names the question, the option and the address, and disclaims transactions', async () => {
    const { message } = await issueVote(alice, 'b');
    expect(message).toMatch(/^Vote on test\.local\n/);
    expect(message).toContain('does not authorize any transaction');
    expect(message).toContain('Question: Pick one (q1)');
    expect(message).toContain('Option: Option B (b)');
    expect(message).toContain(`Address: ${alice.address}`);
    expect(message).toMatch(/Nonce: [0-9a-f]{32}/);
  });
});

describe.each([
  ['MemoryVoteStore', () => new MemoryVoteStore()],
  ['SqliteVoteStore', () => new SqliteVoteStore(':memory:')],
])('%s', (_name, make) => {
  const row: Vote = {
    questionId: 'q1',
    address: 'addr1',
    optionId: 'a',
    alpha: '123456789012345678901234567890',
    votedAt: '2026-01-02T00:00:00.000Z',
  };

  it('inserts, reads back and lists votes without losing precision', async () => {
    const store = make();
    expect(await store.insert(row)).toBe('inserted');
    expect(await store.get('q1', 'addr1')).toEqual(row);
    expect(await store.get('q1', 'other')).toBeUndefined();
    expect(await store.list()).toEqual([row]);
  });

  it('enforces one vote per (question, address) and keeps the first', async () => {
    const store = make();
    expect(await store.insert(row)).toBe('inserted');
    expect(await store.insert({ ...row, optionId: 'b', alpha: '1' })).toBe('duplicate');
    expect(await store.get('q1', 'addr1')).toEqual(row);
    expect(await store.list()).toHaveLength(1);
  });

  it('allows the same address on different questions and different addresses on one', async () => {
    const store = make();
    expect(await store.insert(row)).toBe('inserted');
    expect(await store.insert({ ...row, questionId: 'q2' })).toBe('inserted');
    expect(await store.insert({ ...row, address: 'addr2' })).toBe('inserted');
    expect(await store.list()).toHaveLength(3);
  });
});

describe('SqliteVoteStore', () => {
  it('rejects a non-integer alpha at the database level', async () => {
    const store = new SqliteVoteStore(':memory:');
    const bad = { questionId: 'q1', address: 'a', optionId: 'a', votedAt: 'x' };
    await expect(store.insert({ ...bad, alpha: '1.5' })).rejects.toThrow();
    await expect(store.insert({ ...bad, alpha: '-1' })).rejects.toThrow();
    await expect(store.insert({ ...bad, alpha: '' })).rejects.toThrow();
  });
});
