import { ensureSchema, getSql } from './postgres';
import type { InsertVoteResult, Vote, VoteStore } from './voteStore';

interface VoteRow {
  question_id: string;
  address: string;
  option_id: string;
  alpha: string;
  voted_at: string;
}

function toVote(row: VoteRow): Vote {
  return {
    questionId: row.question_id,
    address: row.address,
    optionId: row.option_id,
    alpha: row.alpha,
    votedAt: row.voted_at,
  };
}

/** Votes in Postgres. The primary key on (question_id, address) is the lock. */
export class PostgresVoteStore implements VoteStore {
  async insert(vote: Vote): Promise<InsertVoteResult> {
    await ensureSchema();
    const rows = await getSql()`
      INSERT INTO votes (question_id, address, option_id, alpha, voted_at)
      VALUES (${vote.questionId}, ${vote.address}, ${vote.optionId}, ${vote.alpha}, ${vote.votedAt})
      ON CONFLICT (question_id, address) DO NOTHING
      RETURNING question_id
    `;
    return rows.length === 0 ? 'duplicate' : 'inserted';
  }

  async get(questionId: string, address: string): Promise<Vote | undefined> {
    await ensureSchema();
    const rows = (await getSql()`
      SELECT question_id, address, option_id, alpha, voted_at
      FROM votes
      WHERE question_id = ${questionId} AND address = ${address}
    `) as VoteRow[];
    const row = rows[0];
    return row && toVote(row);
  }

  async list(): Promise<Vote[]> {
    await ensureSchema();
    const rows = (await getSql()`
      SELECT question_id, address, option_id, alpha, voted_at
      FROM votes
      ORDER BY voted_at ASC, address ASC
    `) as VoteRow[];
    return rows.map(toVote);
  }
}
