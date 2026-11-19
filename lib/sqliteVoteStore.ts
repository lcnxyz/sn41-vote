import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PostgresVoteStore } from './postgresVoteStore';
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

/** Votes in a single SQLite file. Fine for one Node process; use a server database beyond that. */
export class SqliteVoteStore implements VoteStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        question_id TEXT NOT NULL,
        address     TEXT NOT NULL,
        option_id   TEXT NOT NULL,
        alpha       TEXT NOT NULL CHECK (alpha GLOB '[0-9]*' AND alpha NOT GLOB '*[^0-9]*'),
        voted_at    TEXT NOT NULL,
        PRIMARY KEY (question_id, address)
      ) WITHOUT ROWID;
    `);
  }

  async insert(vote: Vote): Promise<InsertVoteResult> {
    try {
      this.db
        .prepare(
          `INSERT INTO votes (question_id, address, option_id, alpha, voted_at)
           VALUES (@questionId, @address, @optionId, @alpha, @votedAt)`,
        )
        .run(vote);
      return 'inserted';
    } catch (err) {
      // Only a primary key conflict means "already voted". Any other failure (for example the
      // alpha CHECK) must surface instead of being reported as a duplicate.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return 'duplicate';
      throw err;
    }
  }

  async get(questionId: string, address: string): Promise<Vote | undefined> {
    const row = this.db
      .prepare('SELECT * FROM votes WHERE question_id = ? AND address = ?')
      .get(questionId, address) as VoteRow | undefined;
    return row && toVote(row);
  }

  async list(): Promise<Vote[]> {
    const rows = this.db.prepare('SELECT * FROM votes ORDER BY voted_at ASC, address ASC').all() as VoteRow[];
    return rows.map(toVote);
  }
}

const globalForStore = globalThis as unknown as { __voteStore?: VoteStore };

/**
 * Process-wide store. Uses Postgres when `DATABASE_URL` is set (Vercel), and a
 * SQLite file at `VOTES_DB_PATH` (default `data/votes.sqlite`) otherwise.
 */
export function getVoteStore(): VoteStore {
  if (!globalForStore.__voteStore) {
    if (process.env.DATABASE_URL?.trim()) {
      globalForStore.__voteStore = new PostgresVoteStore();
    } else {
      const file = process.env.VOTES_DB_PATH?.trim() || resolve(process.cwd(), 'data', 'votes.sqlite');
      globalForStore.__voteStore = new SqliteVoteStore(file);
    }
  }
  return globalForStore.__voteStore;
}
