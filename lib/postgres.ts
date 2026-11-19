import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let sql: NeonQueryFunction<false, false> | undefined;
let schemaReady: Promise<void> | undefined;

/** Shared Neon client. Throws if `DATABASE_URL` is missing. */
export function getSql(): NeonQueryFunction<false, false> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!sql) sql = neon(url);
  return sql;
}

async function createSchema(): Promise<void> {
  const db = getSql();
  await db`
    CREATE TABLE IF NOT EXISTS votes (
      question_id TEXT NOT NULL,
      address     TEXT NOT NULL,
      option_id   TEXT NOT NULL,
      alpha       TEXT NOT NULL CHECK (alpha ~ '^[0-9]+$'),
      voted_at    TEXT NOT NULL,
      PRIMARY KEY (question_id, address)
    )
  `;
  await db`
    CREATE TABLE IF NOT EXISTS challenges (
      address     TEXT PRIMARY KEY,
      message     TEXT NOT NULL,
      expires_at  BIGINT NOT NULL,
      purpose     TEXT CHECK (purpose IS NULL OR purpose IN ('sign-in', 'vote')),
      question_id TEXT,
      option_id   TEXT
    )
  `;
}

/** Creates the votes and challenges tables once per process. */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = createSchema().catch((err: unknown) => {
      schemaReady = undefined;
      throw err;
    });
  }
  return schemaReady;
}
