import type { ChallengeStore, StoredChallenge } from './challengeStore';
import { ensureSchema, getSql } from './postgres';

interface ChallengeRow {
  address: string;
  message: string;
  expires_at: string | number;
  purpose: string | null;
  question_id: string | null;
  option_id: string | null;
}

function toChallenge(row: ChallengeRow): StoredChallenge {
  const challenge: StoredChallenge = {
    address: row.address,
    message: row.message,
    expiresAt: Number(row.expires_at),
  };
  if (row.purpose === 'sign-in' || row.purpose === 'vote') challenge.purpose = row.purpose;
  if (row.question_id) challenge.questionId = row.question_id;
  if (row.option_id) challenge.optionId = row.option_id;
  return challenge;
}

/**
 * Pending challenges in Postgres, one row per address. `take` is a single
 * DELETE ... RETURNING, so two requests cannot consume the same challenge.
 */
export class PostgresChallengeStore implements ChallengeStore {
  async set(challenge: StoredChallenge): Promise<void> {
    await ensureSchema();
    const db = getSql();
    const now = Date.now();
    await db`DELETE FROM challenges WHERE expires_at <= ${now} AND address <> ${challenge.address}`;
    await db`
      INSERT INTO challenges (address, message, expires_at, purpose, question_id, option_id)
      VALUES (
        ${challenge.address},
        ${challenge.message},
        ${challenge.expiresAt},
        ${challenge.purpose ?? null},
        ${challenge.questionId ?? null},
        ${challenge.optionId ?? null}
      )
      ON CONFLICT (address) DO UPDATE SET
        message = EXCLUDED.message,
        expires_at = EXCLUDED.expires_at,
        purpose = EXCLUDED.purpose,
        question_id = EXCLUDED.question_id,
        option_id = EXCLUDED.option_id
    `;
  }

  async get(address: string): Promise<StoredChallenge | undefined> {
    await ensureSchema();
    const rows = (await getSql()`
      SELECT address, message, expires_at, purpose, question_id, option_id
      FROM challenges
      WHERE address = ${address}
    `) as ChallengeRow[];
    const row = rows[0];
    return row && toChallenge(row);
  }

  async delete(address: string): Promise<void> {
    await ensureSchema();
    await getSql()`DELETE FROM challenges WHERE address = ${address}`;
  }

  async take(address: string): Promise<StoredChallenge | undefined> {
    await ensureSchema();
    const rows = (await getSql()`
      DELETE FROM challenges
      WHERE address = ${address}
      RETURNING address, message, expires_at, purpose, question_id, option_id
    `) as ChallengeRow[];
    const row = rows[0];
    return row && toChallenge(row);
  }
}
