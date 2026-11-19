import { PostgresChallengeStore } from './postgresChallengeStore';

export type ChallengePurpose = 'sign-in' | 'vote';

export interface StoredChallenge {
  address: string;
  message: string;
  expiresAt: number;
  /** Absent means 'sign-in'. A vote challenge can never satisfy a sign-in, and vice versa. */
  purpose?: ChallengePurpose;
  /** Set for vote challenges: the exact question and option the signed message names. */
  questionId?: string;
  optionId?: string;
}

/**
 * Storage for pending challenges, keyed by normalized address. Async so a Redis or database
 * implementation can be swapped in without touching callers.
 */
export interface ChallengeStore {
  set(challenge: StoredChallenge): Promise<void>;
  get(address: string): Promise<StoredChallenge | undefined>;
  delete(address: string): Promise<void>;
  /** Atomically returns and removes the challenge, so it can only be used once. */
  take(address: string): Promise<StoredChallenge | undefined>;
}

const DEFAULT_MAX_ENTRIES = 10_000;

export class MemoryChallengeStore implements ChallengeStore {
  private readonly map = new Map<string, StoredChallenge>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  async set(challenge: StoredChallenge): Promise<void> {
    this.pruneExpired();
    this.map.delete(challenge.address);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(challenge.address, challenge);
  }

  async get(address: string): Promise<StoredChallenge | undefined> {
    return this.map.get(address);
  }

  async delete(address: string): Promise<void> {
    this.map.delete(address);
  }

  async take(address: string): Promise<StoredChallenge | undefined> {
    const challenge = this.map.get(address);
    this.map.delete(address);
    return challenge;
  }

  get size(): number {
    return this.map.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, value] of this.map) {
      if (value.expiresAt <= now) this.map.delete(key);
    }
  }
}

const globalForStore = globalThis as unknown as { __challengeStore?: ChallengeStore };

/**
 * Process-wide store. Uses Postgres when `DATABASE_URL` is set, so a challenge
 * issued on one serverless instance can be consumed on another. Otherwise the
 * in-memory store, which is enough for one local Node process.
 */
export function getChallengeStore(): ChallengeStore {
  if (!globalForStore.__challengeStore) {
    if (process.env.DATABASE_URL?.trim()) {
      globalForStore.__challengeStore = new PostgresChallengeStore();
    } else {
      globalForStore.__challengeStore = new MemoryChallengeStore();
    }
  }
  return globalForStore.__challengeStore;
}
