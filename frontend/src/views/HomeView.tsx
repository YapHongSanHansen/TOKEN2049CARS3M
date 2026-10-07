import { useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHealth } from "../hooks";

/** Home: the pitch from the README, laid out like an editorial front page (numbered sections, mono eyebrows). */
export function HomeView() {
  const health = useHealth();
  const signalPrice = health?.prices?.signal ?? "5";
  const mode = health?.mode === "preprod" ? "Cardano preprod" : "simulated chain";
  // The Ξ slams into the wordmark on load; clicking the wordmark replays it.
  const [slam, setSlam] = useState(0);

  return (
    <div className="hm">
      <section className="hm-hero">
        <p className="hm-eyebrow">TOKEN2049 · Cardano agentic commerce (x402 + Masumi) · {mode}</p>
        <div className="hm-wordmark" aria-label="CARSEM" title="Replay" onClick={() => setSlam(n => n + 1)}>CARS<span key={slam} className="hm-xi" aria-hidden><i /></span>M</div>
        <h1 className="hm-title">Your agent never stops at a paywall.</h1>
        <p className="hm-sub">It borrows against your data, earns while you sleep, and repays itself.</p>
        <div className="hm-cta">
          <Button size="lg" asChild><a href="#start">Get started <ArrowRight className="size-4" /></a></Button>
          <Button size="lg" variant="outline" asChild><a href="#agent">Open My agent</a></Button>
          <Button size="lg" variant="ghost" asChild><a href="#market">See the Market</a></Button>
        </div>
        <ul className="hm-badges">
          <li><span>chain</span>Cardano preprod</li>
          <li><span>payments</span>x402</li>
          <li><span>agents</span>Masumi Network</li>
          <li><span>status</span>MVP in progress</li>
        </ul>
      </section>

      <section className="hm-metrics" aria-label="Key numbers">
        <Metric label="The trigger" value="402" unit="Payment Required" note="an agent with a goal, an empty wallet and no way forward" />
        <Metric label="Starting wallet" value="0.05" unit="USDM" note="every agent wallet starts nearly empty, on purpose" />
        <Metric label="Signal paywall" value={signalPrice} unit="USDM" note="a trading signal costs more than the agent holds" />
        <Metric label="Loan fee" value="2" unit="%" note="repay in time and the collateral is released" />
      </section>

      <Section n="01" title="The problem">
        <p>Autonomous agents get a wallet and a goal, then they hit an HTTP <code>402 Payment Required</code> with an empty balance, and stall. Usually at 3am, while you sleep. Today the only answer is "top up and try again," which defeats the point of autonomy.</p>
        <p>Meanwhile the most valuable asset the user already owns, the intent sitting inside their chat history ("cheapest flight KL → Singapore", "girlfriend's birthday on the 30th, what should I buy?"), is worth real money to enterprises and earns the user nothing.</p>
      </Section>

      <Section n="02" title="The idea">
        <p className="hm-lead">CARSΞM is a credit layer for AI agents, built on Cardano on top of the Masumi Network.</p>
        <p>When an agent can't afford a paid resource, it <strong>borrows</strong> from CARSΞM Lending, posting the <strong>rights to the user's redacted chat data</strong> as collateral. It pays, it trades, it earns, it repays, and the collateral is released. If it never repays, the redacted bundle is listed on the CARSΞM marketplace, where enterprises that already bid for that data buy it, and the loan settles itself.</p>
        <aside className="hm-callout">Masumi has <strong>no lending primitive</strong>. CARSΞM Lending is our contribution to the ecosystem: agent-native, under-collateralised credit backed by consented data rights.</aside>
      </Section>

      <Section n="03" title="Architecture">
        <figure className="hm-figure">
          <img src="/architecture.png" alt="CARSEM architecture: the user's chat and Masumi DID on the left, the agent loop in the centre, the CARSEM platform and enterprise bids on the right, Masumi decision logging below" />
        </figure>
        <table className="hm-table">
          <tbody>
            <tr><th>Left — Masumi DIDs / credentials</th><td>The user's chat interface. Every message carries latent intent (flights, hotels, gifts, trading signals). The agent carries a Masumi DID.</td></tr>
            <tr><th>Centre — the agent loop</th><td>The wallet shows 0.05 USDM. The agent hits a 402, finds it can't pay, and takes a collateralised loan instead of giving up.</td></tr>
            <tr><th>Right — CARSΞM platform</th><td>The x402 seller: trading signals for Cardano DEX tokens and live flight / hotel prices, uploaded by many users, each with a reputation score.</td></tr>
            <tr><th>Bottom — decision logging</th><td><code>hash(request + data)</code> written on chain as proof of delivery.</td></tr>
            <tr><th>Far right — enterprise</th><td>eBay, Amazon, Meta and BNB standing bids for redacted user data (50 / 25 / 5 / 10 USDM).</td></tr>
            <tr><th>Red path — "else default"</th><td>No repayment → the redacted bundle is published on CARSΞM behind a paywall, and that sale clears the loan.</td></tr>
          </tbody>
        </table>
      </Section>

      <Section n="04" title="The loop">
        <ol className="hm-steps">
          <Step n={1} who="User → Agent">"Find me trading signals, make me some pocket money."</Step>
          <Step n={2} who="Agent → CARSΞM">GET the latest MIN signal. <em>HTTP 402: pay {signalPrice} USDM.</em></Step>
          <Step n={3} who="Agent">Checks its wallet: 0.05 USDM, less than {signalPrice}.</Step>
          <Step n={4} who="Agent → Lending">Asks the user which past messages to pledge; the treasury sends {signalPrice} USDM, the collateral is locked.</Step>
          <Step n={5} who="Agent → CARSΞM">Pays over x402, gets the signal; <code>hash(request + signal)</code> is logged on chain.</Step>
          <Step n={6} who="Agent → DEX">Trades the signal (Minswap, simulated fill on preprod).</Step>
          <Step n={7} who="Green path" tone="good">Repays over x402. Collateral released, nothing published.</Step>
          <Step n={7} who="Red path" tone="bad">Deadline passes. The redacted bundle is listed behind a paywall; an enterprise buys it and the loan settles itself.</Step>
        </ol>
      </Section>

      <Section n="05" title="What we use from Masumi">
        <table className="hm-table">
          <tbody>
            <tr><th>Agent registry / identity (DID)</th><td>Both the AI agent (buyer) and CARSΞM (seller) carry DIDs; registration on the preprod registry needs a public URL.</td></tr>
            <tr><th>Escrow payments</th><td>Step 5: the data purchase settles through x402 and Masumi escrow, not a raw transfer.</td></tr>
            <tr><th>Decision logging</th><td>Step 5: <code>hash(request + delivered signal)</code> written on chain as proof of delivery.</td></tr>
          </tbody>
        </table>
        <p className="hm-muted">Everything else, the lending ledger, collateral model, redaction pipeline, reputation scoring and enterprise marketplace, is CARSΞM.</p>
      </Section>

      <Section n="06" title="Privacy & consent">
        <p>This only works if the user is genuinely in control. The non-negotiables:</p>
        <ul className="hm-list">
          <li><strong>Explicit opt-in</strong>, not buried in T&amp;Cs: "Allow my agent to borrow against my redacted chat data", with a revoke toggle.</li>
          <li><strong>Raw chats never leave the user.</strong> Only redacted bundles are used as collateral, and only redacted bundles are ever sold.</li>
          <li><strong>The user picks the collateral.</strong> Each loan pledges only the messages they tick; nothing else is locked.</li>
          <li><strong>Redaction on arrival.</strong> "My girlfriend's birthday on 30th Sept" becomes <code>[PERSON] birthday on [DATE]</code>. Names, dates, phones, emails, addresses, accounts and API keys are stripped before anything is stored, hashed or listed.</li>
        </ul>
      </Section>

      <section className="hm-final">
        <h2>Verify once, then use CARSΞM from any AI app.</h2>
        <p>ChatGPT, Claude, Claude Code, Hermes or curl. Your Cardano wallet is your account.</p>
        <Button size="lg" asChild><a href="#start">Get started <ArrowRight className="size-4" /></a></Button>
      </section>

      <footer className="hm-foot">
        <span><strong>CARSΞM</strong> — credit infrastructure for autonomous agents, on Cardano.</span>
        <nav>
          <a href="https://github.com/YapHongSanHansen/TOKEN2049CARS3M" target="_blank" rel="noreferrer">GitHub <ArrowUpRight className="size-3" /></a>
          <a href="https://docs.masumi.network" target="_blank" rel="noreferrer">Masumi docs <ArrowUpRight className="size-3" /></a>
          <a href="https://github.com/cardano-foundation/x402-cardano-demo" target="_blank" rel="noreferrer">x402 on Cardano <ArrowUpRight className="size-3" /></a>
          <a href="https://preprod.cardanoscan.io" target="_blank" rel="noreferrer">Preprod explorer <ArrowUpRight className="size-3" /></a>
        </nav>
      </footer>
    </div>
  );
}

function Metric({ label, value, unit, note }: { label: string; value: string; unit: string; note: string }) {
  return (
    <div className="hm-metric">
      <span>{label}</span>
      <div><strong>{value}</strong><em>{unit}</em></div>
      <small>{note}</small>
    </div>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="hm-section">
      <header><span className="hm-num">{n}</span><h2>{title}</h2></header>
      <div className="hm-body">{children}</div>
    </section>
  );
}

function Step({ n, who, tone, children }: { n: number; who: string; tone?: "good" | "bad"; children: React.ReactNode }) {
  return (
    <li className={`hm-step ${tone ?? ""}`}>
      <span className="hm-step-n">{String(n).padStart(2, "0")}</span>
      <div><span className="hm-step-who">{who}</span><p>{children}</p></div>
    </li>
  );
}
