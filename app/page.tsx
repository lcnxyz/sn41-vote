import Ballot from './components/WalletGate';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main>
      <span className="eyebrow">Subnet 41</span>
      <h1>Voting</h1>
      <p className="subtitle">
        Vote on questions from the subnet. Each vote counts for the alpha you hold when you cast it.
        Results and every vote are public.
      </p>
      <Ballot />
    </main>
  );
}
