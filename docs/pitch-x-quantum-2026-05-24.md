---
marp: true
theme: default
size: 16:9
paginate: false
backgroundColor: '#0a0a0c'
color: '#ffffff'
style: |
  section {
    background: #0a0a0c;
    color: #ffffff;
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    padding: 60px 80px;
    background-image:
      linear-gradient(to right, rgba(57, 197, 187, 0.04) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(57, 197, 187, 0.04) 1px, transparent 1px);
    background-size: 60px 60px;
  }
  section.cover {
    text-align: center;
    align-items: center;
    justify-content: center;
  }
  h1 { color: #ffffff; font-size: 64px; font-weight: 800; letter-spacing: -0.02em; }
  h2 { color: #ffffff; font-size: 44px; font-weight: 700; line-height: 1.15; margin-bottom: 20px; }
  h3 { color: #39c5bb; font-size: 26px; font-weight: 700; margin-top: 0; margin-bottom: 10px; }
  h4 { color: #39c5bb; font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 10px; }
  .eyebrow { color: #888892; font-family: 'JetBrains Mono', monospace; font-size: 14px; letter-spacing: 0.2em; text-transform: uppercase; margin-bottom: 18px; }
  .accent { color: #39c5bb; }
  .red { color: #ff3366; }
  .yellow { color: #ffcc00; }
  .pink { color: #ff77a8; }
  .cyan-bright { color: #00ffe5; }
  .lead { font-size: 19px; line-height: 1.5; color: #cccccf; margin: 14px 0; }
  .small { font-size: 15px; line-height: 1.5; color: #cccccf; }
  .dim { color: #888892; }
  .quote { font-family: 'Orbitron', sans-serif; font-size: 30px; font-style: italic; color: #39c5bb; text-align: center; padding: 22px 0; }
  .stat { display: inline-block; padding: 14px 18px; margin: 5px; border: 1px solid #2a2a30; border-radius: 12px; background: #151518; min-width: 140px; text-align: center; vertical-align: top; }
  .stat-num { font-family: 'Orbitron', sans-serif; font-weight: 800; font-size: 34px; display: block; }
  .stat-lbl { font-size: 12px; color: #888892; margin-top: 4px; letter-spacing: 0.05em; }
  .grid { display: grid; gap: 14px; margin-top: 16px; }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  .card { background: #151518; border: 1px solid #2a2a30; border-left: 3px solid #39c5bb; border-radius: 12px; padding: 18px; }
  .card-pink { border-left-color: #ff77a8; }
  .card-yellow { border-left-color: #ffcc00; }
  .card-red { border-left-color: #ff3366; }
  .flow { display: flex; align-items: center; gap: 8px; margin: 18px 0; flex-wrap: wrap; }
  .flow-node { flex: 1; min-width: 180px; background: #151518; border: 1px solid #2a2a30; border-radius: 12px; padding: 14px; }
  .flow-node strong { display: block; color: #39c5bb; font-family: 'Orbitron', sans-serif; font-size: 15px; margin-bottom: 6px; }
  .flow-node span { font-size: 12.5px; color: #cccccf; line-height: 1.4; }
  .flow-arrow { color: #39c5bb; font-size: 24px; font-weight: 700; }
  pre { background: #0f0f12 !important; border: 1px solid #2a2a30; border-radius: 10px; padding: 14px; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; line-height: 1.5; color: #cccccf; }
  code { color: #00ffe5; }
  ul { font-size: 15.5px; line-height: 1.55; color: #cccccf; margin-top: 6px; }
  li { margin-bottom: 5px; }
  .kpi { display: inline-block; padding: 6px 12px; margin: 4px; border: 1px solid #39c5bb; border-radius: 999px; color: #39c5bb; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; }
  .meta { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #888892; letter-spacing: 0.15em; margin-top: 10px; }
  .brand-number { font-family: 'Orbitron', sans-serif; font-weight: 900; font-size: 180px; color: #39c5bb; line-height: 0.9; }
  .brand-word { font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: 36px; letter-spacing: 0.3em; color: #ffffff; margin-top: -8px; }
  .tagline { font-size: 50px; font-weight: 800; margin-top: 28px; line-height: 1.1; }
  .subline { font-size: 18px; color: #cccccf; margin-top: 16px; max-width: 800px; line-height: 1.5; }
  .divider { width: 80px; height: 3px; background: #39c5bb; margin: 24px auto; }
  .highlight { margin-top: 18px; padding: 14px 18px; border-left: 3px solid #ffcc00; background: rgba(255, 204, 0, 0.05); font-size: 16px; color: #ffffff; }
  .layer-row { display: flex; align-items: stretch; gap: 12px; margin: 14px 0; }
  .layer-box { flex: 1; padding: 16px; border-radius: 12px; background: #151518; border: 1px solid #2a2a30; text-align: center; }
  .layer-box.swap { border: 2px solid #ffcc00; box-shadow: 0 0 24px rgba(255, 204, 0, 0.15); }
  .layer-box.lock { border: 2px solid #39c5bb; box-shadow: 0 0 24px rgba(57, 197, 187, 0.15); }
  .layer-label { font-family: 'Orbitron', sans-serif; font-size: 14px; letter-spacing: 0.1em; color: #888892; text-transform: uppercase; margin-bottom: 6px; }
  .layer-name { font-family: 'Orbitron', sans-serif; font-size: 22px; font-weight: 700; }
  .layer-desc { font-size: 12px; color: #888892; margin-top: 4px; line-height: 1.4; }
  .judge-pill { display: inline-block; padding: 4px 10px; margin: 2px; border-radius: 4px; background: rgba(57, 197, 187, 0.1); border: 1px solid rgba(57, 197, 187, 0.3); color: #39c5bb; font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.05em; }
---

<!-- _class: cover -->

<div class="brand-number">01</div>
<div class="brand-word">PROTOCOL</div>
<div class="divider"></div>
<div class="tagline">Crypto-Agile <span class="accent">Private Subscriptions</span><br>on Solana</div>
<p class="subline">Subscribe · pause · cancel — without ever revealing who you are.<br>Post-quantum by construction. Migration-ready from day one.</p>
<div class="meta">SLASHY · ALEX · SAM</div>
<div class="meta" style="color:#555560">X QUANTUM HACKATHON · DUBLIN · 2026-05-24</div>

---

<div class="eyebrow"><span class="accent">01</span> · The problem</div>

## Every signature you sign today<br>is <span class="red">tomorrow's loot</span>.

<p class="lead">Crypto-agility isn't optional — it's the only viable strategy against zero-day breaks of foundational primitives. The industry has none.</p>

<div>
  <span class="stat"><span class="stat-num red">23M</span><span class="stat-lbl">23andMe leaked 2023</span></span>
  <span class="stat"><span class="stat-num red">100%</span><span class="stat-lbl">Solana txs are public</span></span>
  <span class="stat"><span class="stat-num yellow">5–10y</span><span class="stat-lbl">Until Shor breaks Ed25519</span></span>
  <span class="stat"><span class="stat-num pink">0</span><span class="stat-lbl">PQ-safe subs on Solana</span></span>
</div>

<div class="highlight"><strong>Harvest-now, decrypt-later</strong> is already happening. NIST mandates government PQ migration by 2030–2035. Today's wallet stack is unprepared.</div>

---

<div class="eyebrow"><span class="accent">02</span> · Crypto-agility framework</div>

## We <span class="accent">separate the transport</span> from the lock.

<div class="layer-row">
  <div class="layer-box swap">
    <div class="layer-label">SWAPPABLE</div>
    <div class="layer-name yellow">Transport signature</div>
    <div class="layer-desc">Today: Ed25519<br>Tomorrow: Dilithium/Falcon<br>Bridge: ephemeral submitter</div>
  </div>
  <div class="flow-arrow" style="align-self:center;font-size:32px;">⊕</div>
  <div class="layer-box lock">
    <div class="layer-label">POST-QUANTUM</div>
    <div class="layer-name accent">Spend authorization</div>
    <div class="layer-desc">STARK over Goldilocks<br>+ Poseidon hashes<br>Shor-immune by design</div>
  </div>
  <div class="flow-arrow" style="align-self:center;font-size:32px;">=</div>
  <div class="layer-box">
    <div class="layer-label">RESULT</div>
    <div class="layer-name">Funds safe</div>
    <div class="layer-desc">Even if Ed25519 falls.<br>Even if validators<br>haven't migrated yet.</div>
  </div>
</div>

<p class="lead"><strong>The transport postman can be replaced.</strong> The lock is already post-quantum. No fork, no migration, no asset risk — algorithms swap independently.</p>

<div class="quote">« Ed25519 is the postman. STARK is the lock. »</div>

---

<div class="eyebrow"><span class="accent">03</span> · The solution</div>

## Three guarantees. <span class="accent">Live on devnet today.</span>

<div class="grid grid-3">
  <div class="card">
    <h4>Invisible to the merchant</h4>
    <p class="small">The merchant verifies a <strong>STARK proof</strong>, never a signature. They learn one fact: <em>this subscription is valid for this period</em>. Not your wallet. Not your identity.</p>
  </div>
  <div class="card card-pink">
    <h4 class="pink">Useless to the hacker</h4>
    <p class="small">The merchant DB stores only <strong>32-byte commitments</strong>. No card, no email, no address. A breach leaks meaningless hashes. Nothing to sell.</p>
  </div>
  <div class="card card-yellow">
    <h4 class="yellow">Quantum-safe today</h4>
    <p class="small">Authentication uses <strong>STARK over Goldilocks + Poseidon</strong>. Zero elliptic curves in the auth path. Shor cannot touch it. 128-bit PQ effective security.</p>
  </div>
</div>

<div class="quote">« Prove who paid. Never reveal who. »</div>

---

<div class="eyebrow"><span class="accent">04</span> · How it works</div>

## The subscription lifecycle, <span class="accent">end to end private</span>.

<div class="flow">
  <div class="flow-node"><strong>1. Shield</strong><span>Pay into denominated pool. Receive a Poseidon commitment.</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node"><strong>2. Subscribe</strong><span>Bind commitment to merchant vault. STARK-proven on-chain.</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node"><strong>3. Use</strong><span>Each period: STARK auth + ephemeral session token.</span></div>
  <div class="flow-arrow">→</div>
  <div class="flow-node"><strong>4. Pause / Cancel</strong><span>Anytime. Funds freeze or refund to fresh commitment.</span></div>
</div>

<pre><code><span class="dim">// On-chain, the merchant DB sees only this:</span>
<span class="accent">SubscriberVault</span> {
  service_id: <span class="yellow">"disney-plus"</span>,
  subscriber_commitment: <span class="cyan-bright">[u8; 32]</span>,  <span class="dim">// Goldilocks u64 LE</span>
  state: <span class="pink">Active</span> | Paused | Cancelled,
  period_start_slot: <span class="cyan-bright">461_645_801</span>,
}
<span class="dim">// No wallet. No email. No card. Just a hash.</span>
</code></pre>

---

<div class="eyebrow"><span class="accent">05</span> · Impact & reach</div>

## One primitive. <span class="accent">Every digital asset use case.</span>

<div class="grid grid-3" style="margin-top:8px;">
  <div class="card">
    <h4>Subscriptions (shipped)</h4>
    <p class="small">SaaS, streaming, recurring DAO dues. Replaces Stripe-style PCI/PII storage with 32-byte commitments. <strong>$0.0015/op.</strong></p>
  </div>
  <div class="card card-pink">
    <h4 class="pink">Custody & wallets</h4>
    <p class="small">STARK-gated smart-contract wallet (<code>p01_quantum_vault</code>). Spending key never signs an EC curve. SPHINCS+ recovery path.</p>
  </div>
  <div class="card card-yellow">
    <h4 class="yellow">Payments & micropayments</h4>
    <p class="small">Anonymity-set-backed transfers. Same denominated-pool primitive scales to per-API-call billing, content paywalls, anonymous tipping.</p>
  </div>
  <div class="card">
    <h4>Identity & attestations</h4>
    <p class="small">Optional zk-attestation slots (OFAC, age, KYC). Plug in zkPass / Reclaim — merchant accepts proofs privately, no PII handling.</p>
  </div>
  <div class="card card-pink">
    <h4 class="pink">DeFi & DAOs</h4>
    <p class="small">Confidential balance proofs (circuit 1). Vote weight without revealing wallet. Yield routing without leaking position size.</p>
  </div>
  <div class="card card-yellow">
    <h4 class="yellow">Gaming & in-app</h4>
    <p class="small">Per-asset commitments — character ownership without revealing player. Streamer monetization without sponsor leak.</p>
  </div>
</div>

<p class="lead" style="margin-top:14px;"><strong>SDK integration:</strong> 3 lines of TypeScript. <code>verifySubscription(commitment, serviceId)</code> → 402 or 200. Drop-in for any merchant backend.</p>

---

<div class="eyebrow"><span class="accent">06</span> · Architecture & feasibility</div>

## <span class="accent">Solana-native.</span> Mainnet-ready primitives.

<div class="grid grid-2">
  <div class="card">
    <h4>What runs where</h4>
    <ul class="small">
      <li><strong>On-device:</strong> Winterfell STARK prover (WASM, Goldilocks, Poseidon AIR). 8–15s per proof on mid-range Android.</li>
      <li><strong>On-chain:</strong> 12 Solana programs (Anchor 0.32). STARK verifier consumes ~1.3M CU. Buffer rent recoverable (<0.001 SOL/op).</li>
      <li><strong>Off-chain (opt-in):</strong> N-relayer registry. Liveness-filtered, auto-rotating. Mobile fallback to direct submission.</li>
    </ul>
  </div>
  <div class="card card-pink">
    <h4 class="pink">Deployment trajectory</h4>
    <ul class="small">
      <li><strong>Today:</strong> Devnet · 12 programs · 6 circuits · Real subscriptions billed in SOL.</li>
      <li><strong>Q3 2026:</strong> Audit · STARK multi-spend vault · Mainnet beta.</li>
      <li><strong>2027–2030:</strong> Migrate transport signature to Dilithium when Solana validators adopt PQ. <em>Zero protocol changes required</em> — the lock layer is already PQ.</li>
    </ul>
  </div>
</div>

<div class="highlight"><strong>Trade-offs:</strong> STARK proofs are ~145 KB (vs 256 B Groth16) → chunked upload + buffer rent. <strong>Mitigated by:</strong> pre-computed proof pool roadmap, buffer rent refund on close. <strong>Decentralisation:</strong> relayer is privacy-enhancing, not load-bearing — auth runs on Solana validators only.</div>

---

<div class="eyebrow"><span class="accent">07</span> · Shipped · what we need</div>

<div class="grid grid-2" style="margin-top:8px;">
  <div class="card">
    <h4>Shipped today</h4>
    <ul class="small">
      <li>12 Solana programs (zk_shielded, p01_relayer, p01_quantum_vault, subscription, specter, …)</li>
      <li>6 STARK circuits over Goldilocks + Poseidon AIR</li>
      <li>Mobile-native (Expo 54, on-device WASM prover)</li>
      <li>Service Registry: 4 merchants attested live</li>
      <li>Demo Day — first project live on X (2026-05-12)</li>
      <li><strong>Dev3Pack hackathon — #2 worldwide</strong>, Solana track</li>
    </ul>
    <div class="meta">TEAM · SLASHY · ALEX · SAM</div>
  </div>
  <div class="card card-pink">
    <h4 class="pink">What we're looking for</h4>
    <ul class="small">
      <li>Design partners — merchants who want PQ-safe subscriptions <em>before</em> regulators force it</li>
      <li>Grant support for STARK multi-spend vault (Q3 ship)</li>
      <li>Audit budget for <code>p01_quantum_vault</code></li>
      <li>SDK adopters — <strong>3 lines</strong> to integrate</li>
    </ul>
    <div class="meta accent">slashy@protocol01.xyz</div>
  </div>
</div>

<div style="margin-top:16px;">
  <span class="kpi">12 programs</span>
  <span class="kpi">6 STARK circuits</span>
  <span class="kpi" style="border-color:#ff77a8;color:#ff77a8">post-quantum</span>
  <span class="kpi" style="border-color:#ffcc00;color:#ffcc00">live on devnet</span>
  <span class="kpi">crypto-agile</span>
</div>

---

<!-- _class: cover -->

<h1>Thank you.</h1>
<p class="subline">Protocol 01 · Slashy, Alex & Sam · Dublin · May 2026</p>
<div class="meta accent" style="margin-top:32px">slashy@protocol01.xyz · github.com/IsSlashy</div>
<div class="meta dim" style="margin-top:14px">Questions? We have 10 answers ready.</div>
