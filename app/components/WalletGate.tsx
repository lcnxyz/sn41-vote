'use client';

import type { web3Accounts as Web3Accounts } from '@polkadot/extension-dapp';
import { stringToHex } from '@polkadot/util';
import { useCallback, useEffect, useRef, useState } from 'react';

type InjectedAccountWithMeta = Awaited<ReturnType<typeof Web3Accounts>>[number];

const APP_NAME = 'SN41 Voting';
const BALLOT_REFRESH_MS = 15_000;

type Status = 'idle' | 'connecting' | 'connected' | 'challenging' | 'signing' | 'verifying' | 'done';
type QuestionStatus = 'upcoming' | 'open' | 'closed';

interface VerifyResult {
  verified: true;
  address: string;
  netuid: number;
  alpha: string;
  passes: boolean;
}

interface BallotOption {
  id: string;
  label: string;
  alpha: string;
  votes: number;
  sharePercent: string;
}

interface BallotVote {
  address: string;
  optionId: string;
  alpha: string;
  votedAt: string;
}

interface BallotQuestion {
  id: string;
  title: string;
  body: string;
  opensAt: string;
  closesAt: string;
  status: QuestionStatus;
  totalAlpha: string;
  totalVotes: number;
  options: BallotOption[];
  votes: BallotVote[];
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function accountLabel(account: InjectedAccountWithMeta): string {
  return `${account.meta.name ?? 'Unnamed'} — ${shortAddress(account.address)} (${account.meta.source})`;
}

function isUserRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel|reject|denied/i.test(message);
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // fall through
  }
  return `Request failed with status ${res.status}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Asks the wallet for a raw message signature. Returns null if the user rejected it. This never
 * builds or submits a transaction.
 */
async function signMessage(account: InjectedAccountWithMeta, message: string): Promise<string | null> {
  const { web3FromSource } = await import('@polkadot/extension-dapp');
  const injector = await web3FromSource(account.meta.source);
  const signRaw = injector.signer?.signRaw;
  if (!signRaw) throw new Error('This wallet does not support signing raw messages.');
  try {
    const { signature } = await signRaw({ address: account.address, data: stringToHex(message), type: 'bytes' });
    return signature;
  } catch (err) {
    if (isUserRejection(err)) return null;
    throw err;
  }
}

export default function Ballot() {
  const [questions, setQuestions] = useState<BallotQuestion[] | null>(null);
  const [ballotError, setBallotError] = useState<string | null>(null);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [noExtension, setNoExtension] = useState(false);
  const [accounts, setAccounts] = useState<InjectedAccountWithMeta[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [message, setMessage] = useState<string | null>(null);
  const [session, setSession] = useState<{ account: InjectedAccountWithMeta; result: VerifyResult } | null>(null);

  const [voting, setVoting] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [voteMessage, setVoteMessage] = useState<string | null>(null);
  const signing = useRef(false);

  const busy = status === 'connecting' || status === 'challenging' || status === 'signing' || status === 'verifying';

  const loadBallot = useCallback(async () => {
    try {
      const res = await fetch('/api/ballot', { cache: 'no-store' });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { questions: BallotQuestion[] };
      setQuestions(data.questions);
      setBallotError(null);
    } catch (err) {
      setBallotError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadBallot();
    const timer = setInterval(() => void loadBallot(), BALLOT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadBallot]);

  async function signIn(account: InjectedAccountWithMeta) {
    if (signing.current) return;
    signing.current = true;
    setError(null);
    setSession(null);
    setMessage(null);
    setVoteError(null);
    setVoteMessage(null);
    setSelected(account.address);

    try {
      setStatus('challenging');
      const challengeRes = await fetch(`/api/challenge?address=${encodeURIComponent(account.address)}`, {
        cache: 'no-store',
      });
      if (!challengeRes.ok) throw new Error(await readError(challengeRes));
      const { message: challenge } = (await challengeRes.json()) as { message: string };
      setMessage(challenge);

      setStatus('signing');
      const signature = await signMessage(account, challenge);
      if (!signature) {
        setSelected('');
        setError('Signature request was rejected. Nothing was signed.');
        setStatus('connected');
        return;
      }

      setStatus('verifying');
      const verifyRes = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account.address, signature }),
      });
      if (!verifyRes.ok) throw new Error(await readError(verifyRes));
      setSession({ account, result: (await verifyRes.json()) as VerifyResult });
      setSelected('');
      setStatus('done');
    } catch (err) {
      setSelected('');
      setError(err instanceof Error ? err.message : String(err));
      setStatus('connected');
    } finally {
      signing.current = false;
    }
  }

  async function vote(question: BallotQuestion, option: BallotOption) {
    if (!session || signing.current) return;
    signing.current = true;
    const { account } = session;
    setVoteError(null);
    setVoteMessage(null);
    setVoting(`${question.id}:${option.id}`);

    try {
      const challengeRes = await fetch(
        `/api/vote/challenge?address=${encodeURIComponent(account.address)}` +
          `&questionId=${encodeURIComponent(question.id)}&optionId=${encodeURIComponent(option.id)}`,
        { cache: 'no-store' },
      );
      if (!challengeRes.ok) throw new Error(await readError(challengeRes));
      const { message: challenge } = (await challengeRes.json()) as { message: string };
      setVoteMessage(challenge);

      const signature = await signMessage(account, challenge);
      if (!signature) {
        setVoteError('Signature request was rejected. Your vote was not cast.');
        return;
      }

      const voteRes = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: account.address,
          signature,
          questionId: question.id,
          optionId: option.id,
        }),
      });
      if (!voteRes.ok) throw new Error(await readError(voteRes));
      setVoteMessage(null);
      await loadBallot();
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : String(err));
      void loadBallot();
    } finally {
      signing.current = false;
      setVoting(null);
    }
  }

  async function connect() {
    setError(null);
    setNoExtension(false);
    setSession(null);
    setMessage(null);
    setStatus('connecting');
    try {
      const { web3Accounts, web3Enable } = await import('@polkadot/extension-dapp');
      const extensions = await web3Enable(APP_NAME);
      if (extensions.length === 0) {
        setNoExtension(true);
        setStatus('idle');
        return;
      }
      const list = await web3Accounts({ ss58Format: 42 });
      if (list.length === 0) {
        setError('No accounts found. Create or import an account in your wallet, and allow this site to access it.');
        setStatus('idle');
        return;
      }
      setAccounts(list);
      setSelected('');
      setStatus('connected');
    } catch (err) {
      if (isUserRejection(err)) {
        setError('Wallet request was rejected.');
        setStatus('idle');
        return;
      }
      setError(`Could not connect to wallet: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('idle');
    }
  }

  function chooseAccount(address: string) {
    if (!address || signing.current) return;
    const account = accounts.find((item) => item.address === address);
    if (account) void signIn(account);
  }

  const statusLabel: Partial<Record<Status, string>> = {
    connecting: 'Connecting to wallet…',
    challenging: 'Requesting challenge…',
    signing: 'Waiting for signature in your wallet…',
    verifying: 'Verifying signature and checking SN41 alpha…',
  };

  const holdsAlpha = session ? session.result.passes : false;

  return (
    <>
      {error && <div className="error">{error}</div>}

      {noExtension && (
        <div className="error">
          No wallet extension found, or access was denied. Install{' '}
          <a href="https://polkadot.js.org/extension/" target="_blank" rel="noreferrer">
            Polkadot.js
          </a>
          ,{' '}
          <a href="https://www.talisman.xyz/" target="_blank" rel="noreferrer">
            Talisman
          </a>{' '}
          or{' '}
          <a href="https://www.subwallet.app/" target="_blank" rel="noreferrer">
            SubWallet
          </a>
          , then allow this site and try again.
        </div>
      )}

      <section className="card">
        <h2>Wallet</h2>
        {session ? (
          <>
            <dl>
              <dt>Address</dt>
              <dd className="mono">{session.result.address}</dd>
              <dt>SN{session.result.netuid} alpha</dt>
              <dd>{session.result.alpha}</dd>
            </dl>
            <p className="muted">
              {holdsAlpha
                ? 'Your vote counts for the alpha you hold at the moment you vote. It is recorded with the vote and does not change afterwards.'
                : 'This account holds no SN41 alpha, so it cannot vote. You can still follow the results below.'}
            </p>
          </>
        ) : (
          <p className="muted">
            Connect a wallet to prove you own SN41 alpha. You only sign messages. No transaction is
            created and no funds can move.
          </p>
        )}

        <div className="signin-slot">
          {accounts.length === 0 ? (
            <button onClick={() => void connect()} disabled={busy}>
              {status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
            </button>
          ) : (
            <select value={selected} onChange={(e) => chooseAccount(e.target.value)} disabled={busy}>
              <option value="">{session ? 'Switch account' : 'Choose an account'}</option>
              {accounts.map((account) => (
                <option key={account.address} value={account.address}>
                  {accountLabel(account)}
                </option>
              ))}
            </select>
          )}
        </div>

        {status !== 'connecting' && statusLabel[status] && <p className="muted">{statusLabel[status]}</p>}
        {message && !session && (
          <>
            <p className="muted">Message to sign:</p>
            <pre>{message}</pre>
          </>
        )}
      </section>

      {ballotError && <div className="error">Could not load questions: {ballotError}</div>}
      {voteError && <div className="error">{voteError}</div>}
      {voting && (
        <section className="card">
          <p className="muted">Waiting for your wallet signature. Your vote is cast once you sign.</p>
          {voteMessage && <pre>{voteMessage}</pre>}
        </section>
      )}

      {questions === null && !ballotError && <p className="muted">Loading questions…</p>}
      {questions?.length === 0 && <p className="muted">There are no questions yet.</p>}

      {questions?.map((question) => {
        const own = session ? question.votes.find((item) => item.address === session.result.address) : undefined;
        const canVote = question.status === 'open' && !!session && holdsAlpha && !own;
        const ownOption = own ? question.options.find((option) => option.id === own.optionId) : undefined;
        const labelFor = (optionId: string) => question.options.find((option) => option.id === optionId)?.label ?? optionId;

        return (
          <section className="card question" key={question.id}>
            <div className="question-head">
              <h3 className="question-title">{question.title}</h3>
              <span className={`status ${question.status}`}>{question.status}</span>
            </div>
            {question.body && <p>{question.body}</p>}
            <p className="muted">
              {formatTime(question.opensAt)} – {formatTime(question.closesAt)}
            </p>

            {own && ownOption && (
              <p className="voted">
                You voted for <strong>{ownOption.label}</strong> with {own.alpha} alpha. This vote is locked.
              </p>
            )}
            {question.status === 'open' && !session && <p className="muted">Connect a wallet above to vote.</p>}
            {question.status === 'open' && session && !holdsAlpha && (
              <p className="muted">Only wallets holding SN41 alpha can vote.</p>
            )}

            <ul className="options">
              {question.options.map((option) => (
                <li key={option.id} className={own?.optionId === option.id ? 'mine' : undefined}>
                  <div className="option-head">
                    <span className="option-label">{option.label}</span>
                    <span className="option-share">{option.sharePercent}%</span>
                  </div>
                  <div className="bar">
                    <div className="bar-fill" style={{ width: `${option.sharePercent}%` }} />
                  </div>
                  <div className="option-meta">
                    <span>
                      {option.alpha} alpha · {option.votes} {option.votes === 1 ? 'vote' : 'votes'}
                    </span>
                    {canVote && (
                      <button
                        className="vote-button"
                        aria-label={`Vote for ${option.label}`}
                        onClick={() => void vote(question, option)}
                        disabled={voting !== null}
                      >
                        {voting === `${question.id}:${option.id}` ? 'Signing…' : 'Vote'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <p className="muted">
              {question.totalAlpha} alpha total · {question.totalVotes}{' '}
              {question.totalVotes === 1 ? 'vote' : 'votes'}
            </p>

            {question.votes.length > 0 && (
              <details>
                <summary>All votes ({question.votes.length})</summary>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Wallet</th>
                        <th>Alpha</th>
                        <th>Vote</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {question.votes.map((item) => (
                        <tr key={item.address}>
                          <td title={item.address}>{shortAddress(item.address)}</td>
                          <td>{item.alpha}</td>
                          <td>{labelFor(item.optionId)}</td>
                          <td>{formatTime(item.votedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </section>
        );
      })}
    </>
  );
}
