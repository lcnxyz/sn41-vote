import { afterAll, describe, expect, it } from 'vitest';
import { PostgresChallengeStore } from '../lib/postgresChallengeStore';
import { getSql } from '../lib/postgres';
import { PostgresVoteStore } from '../lib/postgresVoteStore';
import type { Vote } from '../lib/voteStore';

const databaseUrl = process.env.DATABASE_URL?.trim();
const runId = `smoke-${Date.now()}`;
const addressA = `${runId}-a`;
const addressB = `${runId}-b`;

describe.skipIf(!databaseUrl)('Postgres stores', () => {
  const votes = new PostgresVoteStore();
  const challenges = new PostgresChallengeStore();

  const row: Vote = {
    questionId: `${runId}-q`,
    address: addressA,
    optionId: 'a',
    alpha: '123456789012345678901234567890',
    votedAt: '2026-01-02T00:00:00.000Z',
  };

  afterAll(async () => {
    const sql = getSql();
    await sql`DELETE FROM votes WHERE address LIKE ${runId + '%'}`;
    await sql`DELETE FROM challenges WHERE address LIKE ${runId + '%'}`;
  });

  it('inserts, reads back and lists a vote without losing precision', async () => {
    expect(await votes.insert(row)).toBe('inserted');
    expect(await votes.get(row.questionId, addressA)).toEqual(row);
    expect(await votes.get(row.questionId, 'missing')).toBeUndefined();
    const listed = (await votes.list()).filter((vote) => vote.address.startsWith(runId));
    expect(listed).toEqual([row]);
  });

  it('enforces one vote per question and address and keeps the first', async () => {
    expect(await votes.insert({ ...row, optionId: 'b', alpha: '1' })).toBe('duplicate');
    expect(await votes.get(row.questionId, addressA)).toEqual(row);
  });

  it('allows the same address on another question and another address on this one', async () => {
    expect(await votes.insert({ ...row, questionId: `${runId}-q2`, votedAt: '2026-01-03T00:00:00.000Z' })).toBe('inserted');
    expect(await votes.insert({ ...row, address: addressB, votedAt: '2026-01-01T00:00:00.000Z' })).toBe('inserted');
    const listed = (await votes.list()).filter((vote) => vote.address.startsWith(runId));
    expect(listed.map((vote) => vote.address)).toEqual([addressB, addressA, addressA]);
  });

  it('rejects a non-integer alpha and stores nothing', async () => {
    const bad = { questionId: `${runId}-bad`, address: addressA, optionId: 'a', votedAt: '2026-01-04T00:00:00.000Z' };
    await expect(votes.insert({ ...bad, alpha: '1.5' })).rejects.toThrow();
    await expect(votes.insert({ ...bad, alpha: '-1' })).rejects.toThrow();
    await expect(votes.insert({ ...bad, alpha: '' })).rejects.toThrow();
    expect(await votes.get(bad.questionId, addressA)).toBeUndefined();
  });

  it('stores a sign-in challenge and a vote challenge, and take consumes it once', async () => {
    await challenges.set({ address: addressA, message: 'sign in', expiresAt: Date.now() + 60_000 });
    const signIn = await challenges.get(addressA);
    expect(signIn).toMatchObject({ address: addressA, message: 'sign in' });
    expect(signIn?.purpose).toBeUndefined();
    expect(signIn?.questionId).toBeUndefined();

    await challenges.set({
      address: addressA,
      message: 'vote',
      expiresAt: Date.now() + 60_000,
      purpose: 'vote',
      questionId: 'q1',
      optionId: 'a',
    });
    expect(await challenges.take(addressA)).toMatchObject({
      message: 'vote',
      purpose: 'vote',
      questionId: 'q1',
      optionId: 'a',
    });
    expect(await challenges.take(addressA)).toBeUndefined();
  });
});
