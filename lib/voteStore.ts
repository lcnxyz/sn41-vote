export interface Vote {
  questionId: string;
  /** Normalized SS58 address (prefix 42). */
  address: string;
  optionId: string;
  /** SN41 alpha at vote time, raw chain units (1 alpha = 1e9), as an integer string. */
  alpha: string;
  /** ISO 8601 timestamp. */
  votedAt: string;
}

export type InsertVoteResult = 'inserted' | 'duplicate';

/**
 * Persistence for votes. One vote per (questionId, address) is enforced by the store itself, so a
 * race between two requests can never produce two rows.
 */
export interface VoteStore {
  insert(vote: Vote): Promise<InsertVoteResult>;
  get(questionId: string, address: string): Promise<Vote | undefined>;
  list(): Promise<Vote[]>;
}

/** In-memory store with the same rules as the SQLite one. Used by tests. */
export class MemoryVoteStore implements VoteStore {
  private readonly votes = new Map<string, Vote>();

  private static key(questionId: string, address: string): string {
    return `${questionId}\u0000${address}`;
  }

  async insert(vote: Vote): Promise<InsertVoteResult> {
    const key = MemoryVoteStore.key(vote.questionId, vote.address);
    if (this.votes.has(key)) return 'duplicate';
    this.votes.set(key, { ...vote });
    return 'inserted';
  }

  async get(questionId: string, address: string): Promise<Vote | undefined> {
    const vote = this.votes.get(MemoryVoteStore.key(questionId, address));
    return vote && { ...vote };
  }

  async list(): Promise<Vote[]> {
    return [...this.votes.values()].map((vote) => ({ ...vote }));
  }
}
