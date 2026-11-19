# SN41 Voting

A small Next.js app for weighted multiple-choice votes on subnet 41 (SN41). The subnet publishes the questions. A holder connects a wallet, proves they own SN41 alpha by signing a message, and votes. Each vote is weighted by the SN41 alpha the wallet holds at the moment it votes.

## Voting

- **Questions** live in `data/questions.json` (committed). Each has an `id`, `title`, `body`, `opensAt`, `closesAt` and at least two `options`. Edit the file and redeploy to publish, change or close a question. The file is validated on load and the app fails loudly on a mistake. Status is computed from the clock: `upcoming` before `opensAt`, `open` until `closesAt`, `closed` from `closesAt`.
- **One vote per wallet per question, locked.** There is no changing a vote. The wallet's SN41 alpha is read from the chain when the vote is cast and stored with it. Later staking or unstaking does not change the weight.
- **Weighted tally.** An option's weight is the sum of the alpha stored on its votes. Its share is that sum divided by the question's total alpha. All math is integer (9-decimal raw units).
- **Public.** The tally and every vote (wallet, alpha, choice, time) are visible to everyone, including while a question is open.
- **Votes are signed.** Voting is a second message signature that names the question and the option. The server issues a single-use challenge for exactly that question and option, so a sign-in signature cannot be replayed as a vote, and a signature for one option cannot be used for another. A vote needs more than zero SN41 alpha.
- **Storage.** Votes go in a SQLite file, `data/votes.sqlite` by default (override with `VOTES_DB_PATH`, gitignored). A primary key on `(question_id, address)` is what enforces the lock. This assumes a single Node server with a persistent disk. For serverless or several instances, implement `VoteStore` (`lib/voteStore.ts`) on a hosted database.

### Voting API

- `GET /api/ballot`: every question with status, per-option alpha, votes and share, and the full vote list. Public and uncached.
- `GET /api/vote/challenge?address=&questionId=&optionId=`: a single-use message to sign for that vote. `400` for an unknown or closed question or unknown option, `409` if the address already voted.
- `POST /api/vote` with `{ address, signature, questionId, optionId }`: `201 { voted: true, vote }`. `400` bad body or question not open, `401` bad, expired or mismatched signature, `403` no SN41 alpha, `409` already voted, `503` / `504` chain unavailable or slow (the challenge is already used; request a new one).

## Wallet sign-in

The sign-in below is how a holder proves ownership of a wallet before voting.

## How it works

1. The browser connects to an injected Substrate wallet (Polkadot.js extension, Talisman, SubWallet, or any wallet exposing the standard `window.injectedWeb3` interface) and lists accounts with SS58 prefix 42.
2. The user picks an account. The browser calls `GET /api/challenge?address=...`. The server returns a one-time, human-readable message containing the app domain, address, a random nonce and an expiry time.
3. The wallet signs the message with `signer.signRaw({ type: 'bytes' })`. This is a message signature only.
4. The browser posts `{ address, signature }` to `/api/verify`. The server:
   - looks up the challenge and deletes it, so it can never be reused,
   - rejects it if it is missing or expired,
   - verifies the signature against both the `<Bytes>...</Bytes>`-wrapped and the bare message,
   - reads the coldkey's stake on subnet 41 from `StakeInfoRuntimeApi.get_stake_info_for_coldkey` and sums the alpha across every hotkey,
   - passes when that total is greater than zero. There is no minimum beyond that.
5. The UI shows the server's answer: verified, SN41 alpha, and PASS or FAIL.

### Security model

- All verification and the pass/fail decision happen on the server. The UI only displays the server's result.
- The app only ever requests raw message signatures. It never builds, requests or submits an extrinsic, transfer, approval, proxy or staking call.
- It never asks for, accepts or stores seed phrases or private keys.
- Challenges are single-use, expire after `CHALLENGE_TTL_SECONDS`, and are bound to one address.
- Inputs are validated: the address must be valid SS58 (normalized to prefix 42), and the signature must be 0x-prefixed hex of 64 to 66 bytes.

## Setup

Requirements: Node.js 18.18 or newer (20+ recommended) and npm.

```bash
npm install
cp .env.example .env.local
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `BITTENSOR_RPC_URL` | `wss://test.finney.opentensor.ai:443` | Bittensor RPC WebSocket endpoint (testnet by default). |
| `APP_DOMAIN` | `localhost:3000` | Domain shown in the signed message. Set it to your real domain in production. |
| `CHALLENGE_TTL_SECONDS` | `300` | How long a challenge is valid, in seconds. |
| `VOTES_DB_PATH` | `data/votes.sqlite` | SQLite file where votes are stored. |

## Run locally against testnet

```bash
npm run dev
```

Open http://localhost:3000 and click **Sign in with wallet**. Approve the site in your extension, then choose an account. The signature prompt opens as soon as you choose.

A PASS means the account has staked any amount of alpha on subnet 41 of the chain you point at. Testnet subnet 41 is not mainnet SN41. Use the mainnet endpoint below to check the real subnet.

## Switch to mainnet

Set the RPC URL in `.env.local` (or in your hosting provider's environment) and restart the server:

```bash
BITTENSOR_RPC_URL=wss://entrypoint-finney.opentensor.ai:443
```

Nothing else changes. Mainnet and testnet both use SS58 prefix 42.

## Tests

```bash
npm test
```

`tests/verify.test.ts` runs offline. It generates sr25519 keypairs with `@polkadot/keyring`, issues challenges through the same `createChallenge` / `verifyChallenge` code the API routes use, and checks:

- wrapped (browser wallet style) and unwrapped signatures are accepted,
- replays are rejected, and a challenge is consumed even after a failed attempt,
- expired challenges are rejected,
- signatures from another key or over another message are rejected,
- malformed addresses and signatures return 400,
- alpha on subnet 41 is summed across hotkeys, other subnets are ignored, and only a zero total fails.

## API

### `GET /api/challenge?address=<ss58>`

- `200 { message }` on success.
- `400 { error }` if the address is missing or invalid.

### `POST /api/verify`

Body: `{ "address": "<ss58>", "signature": "0x..." }`

- `200 { verified: true, address, netuid: 41, alpha, passes }`. `alpha` is an exact decimal string (9 decimals, same scale as TAO). `passes` is true when `alpha` is greater than zero.
- `400` for an invalid body, address or signature format.
- `401` for no challenge, an expired challenge or an invalid signature.
- `503` if the chain is unavailable, `504` if the chain times out. These responses include `signatureVerified: true`; the challenge has already been used, so the client must request a new one.

## Project structure

```
app/
  page.tsx                  Page shell
  components/WalletGate.tsx Wallet connect, account picker, signing, result (client)
  api/challenge/route.ts    GET: issue a challenge
  api/verify/route.ts       POST: verify signature and check SN41 alpha
  api/ballot/route.ts       GET: questions, weighted tallies, vote list
  api/vote/challenge/route.ts GET: single-use challenge naming one question and option
  api/vote/route.ts         POST: verify the vote signature, snapshot alpha, store the vote
data/questions.json         The subnet's questions (edit and redeploy)
lib/
  questions.ts              Question file validation and open/upcoming/closed status
  castVote.ts               Vote rules: window, lock, signature binding, alpha snapshot
  tally.ts                  Weighted tally and the public ballot view
  voteStore.ts              VoteStore interface + in-memory implementation (tests)
  sqliteVoteStore.ts        SQLite VoteStore and the process-wide instance
  config.ts                 Environment variable parsing and defaults
  validation.ts             SS58 address and signature hex validation
  challengeStore.ts         ChallengeStore interface + in-memory implementation
  challenge.ts              Nonce + message construction
  signature.ts              signatureVerify (wrapped and unwrapped)
  verifyChallenge.ts        Single-use challenge verification (no chain access)
  chain.ts                  Shared lazy ApiPromise with connect/query timeouts
  balance.ts                SN41 alpha lookup (StakeInfoRuntimeApi) and the pass rule
  tao.ts                    Exact 9-decimal formatting with BigInt
tests/verify.test.ts        Offline signature verification tests
tests/voting.test.ts        Offline voting tests: windows, tally math, locks, signature binding, stores
```

## Production notes

- **Challenge storage:** the in-memory store only works for a single server process and is lost on restart. For multiple instances or serverless hosting, implement `ChallengeStore` in `lib/challengeStore.ts` on top of Redis (for example `SET key value EX ttl` plus `GETDEL` for `take`) or a database, and return it from `getChallengeStore()`.
- **Rate limiting:** add rate limiting on both endpoints (per IP and per address).
- **HTTPS:** serve over HTTPS, and set `APP_DOMAIN` to the domain users actually see, so the signed message names your site.
- **Sessions:** this app only reports the result. If you need to gate content, issue a signed session (for example an HTTP-only cookie) from `/api/verify` when `passes` is true.

## What is counted

Only alpha the coldkey has staked on subnet 41, summed across hotkeys, including locked stake. Alpha on other subnets and free TAO are ignored. The lookup is `getSubnetAlpha` in `lib/balance.ts`.
