# -*- coding: utf-8 -*-
"""
Plate copy for the three minute cut.

Every number here survived a four way verification pass against the repo, and
every line the three judge lenses killed is absent. The kills that changed the
copy, kept here so nobody reinstates them:

  - "a test in CI asserts it"  -> liveRelayedShield.test.ts:143 is
    describe.skipIf(!LIVE) behind P01_LIVE_RELAY=1, and CI never sets it.
  - "167.76 s end to end"      -> the run is real, but branch
    demo/castle-dao-2026-09-04 and tag demo-castle-dao-v1 do not exist in this
    repo, so the run is not reproducible. Appendix only, with the caveat.
  - "one proof NOW does two"   -> C7 is measured, not deployed. Say measured.
  - "our fee is 1%"            -> 1% operator + 0.3% on-chain shield = 1.3%
    today on a 1 SOL relayed deposit.
  - "anonymity set of 45"      -> 45 is a ceiling. The effective set is one,
    because four of the SEVEN spends republish the commitment their deposit
    already published. Since 25 August the C7 withdrawal no longer does, so
    "every deployed spend republishes" is now FALSE: do not reinstate it.
    28 August: a seventh spend shipped, unshield_denominated_stark_v4_relayed,
    and it does not republish either. Re-count before quoting -- this number has
    moved three times in four days.
  - "the pool is private"      -> the pool is a CROWD. The guarantee is
    k-anonymity, worth log2(k) bits, which is ZERO at k=1. Name k or say
    nothing. And k is set by the coarsest side channel, not by the leaf count.
  - "ten programs live"        -> always with the denominator, 10 of 14.
  - "cancelling ends the..."   -> our subscription has no cancel instruction.
  - "no customer record anywhere" -> true of the merchant, false of the chain:
    the buyer's payment to the till one hop earlier names their wallet.
"""

SPINE = [
    dict(
        no='01', clock='0:10', seconds=10, cap=12, role='title',
        spoken=(
            "Styx is checkout and subscriptions on Solana. The merchant gets paid on their own "
            "schedule, and never collects a name, email, or card."
        ),
        body='''
<p class="eyebrow">Styx</p>
<h1>Get paid monthly.<br>The merchant collects no name, email, or card.</h1>
<hr class="rule">
<p class="foot">SOLANA DEVNET &nbsp;&middot;&nbsp; NOT AUDITED &nbsp;&middot;&nbsp; NO MAINNET DEPLOYMENT</p>
''',
    ),

    dict(
        no='02', clock='0:20', seconds=20, cap=18, band=True, role='the problem',
        spoken=(
            "Two ways to take a recurring payment today, and both name the payer. Card rails "
            "create a customer record that outlives the purchase: the merchant wanted the money "
            "and inherited the file. Public chains publish the payer to everyone instead. Nobody "
            "chose either. They came with the rails."
        ),
        body='''
<p class="eyebrow">The problem</p>
<h2>Every payment names the payer.</h2>
<p class="lead">Card rails keep the record. Public chains publish it.</p>
''',
    ),

    dict(
        no='03', clock='1:00', seconds=60, cap=5, role='the demo',
        spoken=(
            "Here is what you can check tonight, from an empty directory, with no key and no "
            "SOL. One npm install, one script. It reads the live vaults on devnet and asks the "
            "entitlement question three times. The real subscriber is granted. A different "
            "merchant asking about the same subscriber is denied. A made-up subscriber is "
            "denied. Then an expired one: denied. Two hundred and seventy-three milliseconds, "
            "and there was no name in the vault to collect in the first place. Be clear about "
            "what that proves: entitlement, not privacy. The privacy claim is a different "
            "object, the deposit at leaf seventy-two, and there is a harness in the repo that "
            "checks it and reports our own leak as a failure."
        ),
        body='''
<p class="eyebrow">Demo</p>
<h2>Run it yourself.</h2>
<pre class="term"><span class="c">$ npm install @protocol-01/merchant-sdk @solana/web3.js
$ node merchant-gate.mjs</span>

vaults on chain      : 18
entitlement spread   : ended=9  current=7  paused=2

CURRENT  46d6mEYBrktEFqMkhBjLsEA1rJZDmh2DLzmsafPuDjt7
  the real subscriber  : <span class="ok">GRANTED</span>
  a different merchant : <span class="no">DENIED</span>
  a made-up subscriber : <span class="no">DENIED</span>
  is_active on chain   : true   <span class="c">&lt;- the program never sets it false</span>

ENDED  72n5rpWb2qaPSnnzUjbnoWqQ7qJkESWrA3MQbN3K1TZ
  the real subscriber  : <span class="no">DENIED</span>
  is_active on chain   : true</pre>
<p class="foot">demo/merchant-gate.mjs, ABRIDGED &nbsp;&middot;&nbsp; NO KEY, NO SOL, NO ACCOUNT &nbsp;&middot;&nbsp; 273 ms ON 13 AUGUST<br>
THIS PROVES ENTITLEMENT, NOT PRIVACY &nbsp;&middot;&nbsp; DEVNET MOVES: READ THE ADDRESSES OFF THE SCREEN, NEVER OFF THIS PLATE</p>
''',
    ),

    dict(
        no='04', clock='0:25', seconds=25, cap=25, band=True, role='where the market stops',
        spoken=(
            "Look at what exists. A payment processor hides the payment from the chain and keeps "
            "the identity: the merchant outsources the customer list and inherits it back in the "
            "breach. A public on-chain subscription removes the middleman and publishes the payer "
            "instead. And a shielded pool handles one payment beautifully. A subscription is not "
            "one payment."
        ),
        body='''
<p class="eyebrow">Where the market stops</p>
<h2>Processors keep the customer file. Public chains publish it. Mixers hide one payment, not a schedule.</h2>
<p class="lead">Nobody ships the recurrence.</p>
''',
    ),

    dict(
        no='05', clock='0:25', seconds=25, cap=25, role='what we bring',
        spoken=(
            "So we put the schedule inside the private layer instead of beside it. The vault is "
            "prepaid and addressed by a commitment to a secret, not by a wallet, so the merchant "
            "keeps getting paid and there is no customer file to lose. We wrote the prover and "
            "the verifier ourselves, and we publish our own bugs."
        ),
        body='''
<p class="eyebrow">What we bring</p>
<h2>The schedule lives inside the private layer, not beside it.</h2>
<p class="lead">A prepaid vault pays the merchant. No customer file exists to lose.</p>
''',
    ),

    dict(
        no='06', clock='0:25', seconds=25, cap=20, band=True, role='what a merchant gets',
        spoken=(
            "Today: one npm install, one percent plus three tenths on chain. Behind it: "
            "ten of fourteen programs live on devnet, four thousand two hundred and "
            "sixteen tests green. The caveat: four of our seven spends still republish their "
            "commitment, so the crowd is one. C7 closed the withdrawal and the "
            "subscription. Privacy is a crowd that grows."
        ),
        body='''
<p class="eyebrow">Today</p>
<h2>One npm install. The merchant keeps their checkout. We take 1.3%.</h2>
<p class="lead">Live on devnet, not audited.</p>
''',
    ),

    dict(
        no='07', clock='0:15', seconds=15, cap=15, role='the ask',
        spoken=(
            "Two things. One merchant with recurring revenue who will pilot this on devnet. And "
            "the audit funded, because nothing touches real money before it lands. It is all in "
            "the public repo. Go break it."
        ),
        body='''
<p class="eyebrow">The ask</p>
<h2>One pilot merchant. One funded audit.</h2>
<p class="lead">Break it first: github.com/IsSlashy/Protocol-01</p>
''',
    ),
]

DIVIDER = dict(
    no='&middot;', clock='', role='divider', cap=None, seconds=0, spoken='',
    body='''
<p class="eyebrow" style="color: var(--admission)">Appendix</p>
<h2 class="seal" style="color: var(--admission)">Ten plates, none of them in the three minutes.</h2>
<p class="lead">
  The three minutes above carry seven plates and 113 words on screen. Everything a jury
  normally asks for is here instead: the landscape, the use cases, the measured state, the
  verifier's three answers, the fee schedule, what is in flight, the team, two lists of limits,
  and the spoken script with its budget. Open the one you are asked about.
</p>
''',
)

APPENDIX = [
    dict(no='A1', clock='', role='landscape', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A1 &middot; the landscape</p>
<h2>Three ways this is solved today, and what each one gives up.</h2>
<p>
  Approaches, not product names. A competitor fact we cannot check on disk is a fact a judge
  can break in the next question.
</p>
<div class="scroll">
<table>
  <tr><th>Approach</th><th>What it solves</th><th>What it gives up</th></tr>
  <tr>
    <td class="k">Custodial processor</td>
    <td>Hides the payment from the chain, handles recurrence well.</td>
    <td>Keeps the identity. The merchant outsources the customer list, and inherits it back in a breach.</td>
  </tr>
  <tr>
    <td class="k">Public on-chain subscription</td>
    <td>Removes the middleman and the chargeback.</td>
    <td>Publishes the payer. Vault fields, retailer and schedule are enumerable by anyone with an RPC endpoint.</td>
  </tr>
  <tr>
    <td class="k">Shielded pool, spend side only</td>
    <td>Breaks the trace at withdrawal.</td>
    <td>Leaves the deposit hop naming a wallet, and handles one payment, not a schedule.</td>
  </tr>
  <tr>
    <td class="k">Styx</td>
    <td>Relays the deposit and addresses the subscription by a commitment to a secret, so no address can be re-derived to ask whether a wallet subscribes.</td>
    <td>Devnet only, not audited, and the crowd a buyer hides in has an effective size of one today. See A8.</td>
  </tr>
</table>
</div>
'''),

    dict(no='A2', clock='', role='use cases', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A2 &middot; who buys this</p>
<h2>Two buyers, and the honest split between running and designed.</h2>
<dl class="kv">
  <dt>Running</dt><dd><strong>Subscription seller.</strong> A merchant registers a service and reads entitlement through <span class="hash">@protocol-01/merchant-sdk</span>, published on the public npm registry at 0.1.3. No key, no account, 273 ms.</dd>
  <dt>Running</dt><dd><strong>One-shot purchase by claim code.</strong> 32 bytes from a CSPRNG, consumed by an atomic increment so two concurrent redeemers get exactly one note, and no expiry since commit <span class="hash">636aa139</span>. Someone who paid can come back and use it whenever they want.</dd>
  <dt>Running</dt><dd><strong>Deposit with the buyer off the transaction.</strong> Relayed deposit at leaf 72, slot 486 353 558, re-read by RPC with the buyer absent from the account keys. That is absence from one transaction, not unlinkability: the payment that funded it, one hop earlier, names the wallet.</dd>
  <dt>Running</dt><dd><strong>An adversarial harness anyone can run.</strong> <span class="hash">verify/p01-verify.mjs</span>, ten probes, no install and no RPC: three committed fixtures replay offline in about a second, and CI gates all three. It reports our own v3 commitment leak as FAIL, on purpose. A checker that only ever says green has checked nothing.</dd>
  <dt>Designed</dt><dd><strong>Unlinked spend.</strong> The C7 spend instruction <span class="hash">unshield_denominated_stark_v4</span> is written and verified against the built binary. It is not deployed. Until it is, see the linkage limit in A8.</dd>
  <dt>Not claimed</dt><dd>No user count, no revenue, no volume, no waitlist, no partnership. Test value assets only.</dd>
</dl>
'''),

    dict(no='A3', clock='', role='measured state', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A3 &middot; the measured state</p>
<h2>Eight measurements, each with the date it was taken and the caveat it carries.</h2>
<div class="scroll">
<table>
  <tr><th>What</th><th>Measured</th><th>When, and the caveat</th></tr>
  <tr><td class="k">Programs live</td><td>10 of 14</td><td>Executable at their declared address. The 4 that resolve to null are <span class="hash">p01_zkspl</span>, <span class="hash">subscription</span>, <span class="hash">stream</span> and <span class="hash">whitelist</span>: the recurring path that does run lives inside <span class="hash">zk_shielded</span>, so the program named subscription is superseded, not broken. Slot 486 742 009, 22 August.</td></tr>
  <tr><td class="k">Tests</td><td>4,216 pass, 0 fail</td><td>turbo 3,020 over 16 packages, web pool 504, web ui 483, Rust 209. At master <span class="hash">047cd9b2</span>, 22 August. Higher now after the b7 merge, and we will not guess by how much.</td></tr>
  <tr><td class="k">Three test suites, not one</td><td>test, test:pool, test:ui</td><td>CI invokes all three explicitly, since 22 August. A bare <span class="hash">turbo run test</span> green proves only the first.</td></tr>
  <tr><td class="k">C5 drain</td><td>10 tests, CI runs 8</td><td>Closed 18 August, in CI since 22 August. The 2 skipped read the built <span class="hash">.so</span> and the CI job has no SBF toolchain, so CI proves a source property, not the binary's.</td></tr>
  <tr><td class="k">Shipped prover</td><td>229,640 bytes, sha <span class="hash">51a947e3</span></td><td>Pinned by <span class="hash">shippedBlob.test.ts</span>, which also refuses the 192,732-byte pre-coset build (sha <span class="hash">4ace8913</span>) that the chain rejects. Pinned 22 August.</td></tr>
  <tr><td class="k">Pool</td><td>79 deposited, 34 spent, 45 unspent</td><td>1 SOL pool, re-read 28 August. The closed 0.1 SOL pool holds 82 leaves and 53 unspent &mdash; more notes than the open one. The 41/12 printed here before was read mid-campaign on 21 August and never refreshed.</td></tr>
  <tr><td class="k">Cost of the relayed journey</td><td>0.000485 SOL</td><td>Net network fees on the leaf 72 journey, 22 August. No on-disk log reproduces this one. The buyer's total that day was 1.013 SOL: 1.000 note, 0.003 on-chain shield fee, 0.010 operator fee.</td></tr>
  <tr><td class="k">Purchase to running subscription</td><td>167.76 s</td><td>One recorded run, leaf 33, SubscribePrivateStark at 36,127 of 200,000 CU. <strong>Not reproducible from a tag:</strong> the branch and tag named for that freeze are absent from this repo.</td></tr>
</table>
</div>
'''),

    dict(no='A4', clock='', role='the proof', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A4 &middot; the verifier's three answers</p>
<h2>It accepted one proof and refused the other two for two different reasons.</h2>
<p>A verifier that only ever says yes has proved nothing. The gap between the two refusals is the result.</p>
<div class="scroll">
<table>
  <tr><th>Input</th><th>Answer</th><th>Cost</th><th>What it demonstrates</th></tr>
  <tr><td class="k">Honest proof</td><td class="seal">ACCEPTED</td><td>809,812 CU</td><td>The deployed verifier accepts what the shipped prover produces.</td></tr>
  <tr><td class="k">Forged by one byte</td><td>REJECTED</td><td>542,150 CU</td><td><span class="hash">InvalidProof</span> 6003, caught deep in the DEEP and FRI work. A forgery consistent with its own transcript costs a full pass to catch.</td></tr>
  <tr><td class="k">Public input tampered</td><td>REJECTED</td><td>19,777 CU</td><td>OOD z mismatch, right after step 1. Breaking Fiat-Shamir dies immediately. A 27&times; gap between the two refusal paths.</td></tr>
</table>
</div>
<div class="note">
  <p>
    Two caveats we volunteer. The three figures were measured on devnet on 4 August. The accepted
    proof is transaction <span class="hash">2sLVyzPW&hellip;jZiBR</span>; the two rejections have no
    on-disk transaction log, only the README line. And no proof has ever been produced
    from the browser extension or the phone against the deployed verifier: those two surfaces
    were verified by hash equality with the shipped blob, which is weaker.
  </p>
</div>
'''),

    dict(no='A5', clock='', role='business model', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A5 &middot; the revenue</p>
<h2>One percent is the operator's cut, and it is not the only fee in the repo.</h2>
<p>
  A judge reading the source finds four fee constants, so here is the whole schedule. Any single
  figure answer of the form "our fee is one percent" is incomplete on purpose or by accident.
</p>
<div class="scroll">
<table>
  <tr><th>Fee</th><th>Rate</th><th>Where</th></tr>
  <tr><td class="k">Operator, on a relayed deposit</td><td>1%</td><td><span class="hash">OPERATOR_FEE_BPS = 100n</span>, enforced server side on the relay route.</td></tr>
  <tr><td class="k">Protocol shield, on the way in</td><td>0.3%</td><td><span class="hash">SHIELD_FEE_BPS = 30</span>, on chain, independent of the operator cut.</td></tr>
  <tr><td class="k">Protocol unshield, on the way out</td><td>0.5%</td><td><span class="hash">UNSHIELD_FEE_BPS = 50</span>, same file.</td></tr>
  <tr><td class="k">Fee splitter default</td><td>0.5%</td><td><span class="hash">DEFAULT_FEE_BPS = 50</span>, ceiling 5%.</td></tr>
  <tr><td class="k">Total today, 1 SOL in</td><td>1.3%</td><td>1.003 SOL to the till, 0.010 SOL to the fee sink.</td></tr>
</table>
</div>
<div class="note">
  <p>
    Why the pool is shared and not per merchant: the crowd is the product, and it is the only
    asset that grows for free when a merchant joins. One pool per merchant destroys the thesis.
    The honest half of that sentence is in A8.
  </p>
  <p>
    <strong>What kind of guarantee that is, stated precisely.</strong> We do not encrypt the
    withdrawal. We make it indistinguishable from the others in the pool, so the guarantee is
    k&#8209;anonymity and it is worth log<sub>2</sub>(k) bits &mdash; zero at k&nbsp;=&nbsp;1.
    That is an information&#8209;theoretic property, not a computational one: there is no key an
    adversary could later find, and nothing here is broken by a quantum computer. It is also the
    only privacy property we know of that <em>improves for free</em> as the product is used. The
    cost is that it is worthless on day one and has to be bootstrapped.
  </p>
  <p>
    <strong>Two consequences we designed around.</strong> First, a set does not add across
    denominations, it splits &mdash; hence one denomination, 1&nbsp;SOL, founder decision
    21&nbsp;August (<span class="hash">denominatedPool.ts:215</span>). The measured cost of
    getting that wrong is on this page already: the closed 0.1&nbsp;SOL pool holds 53 unspent
    notes and the open 1&nbsp;SOL pool holds 45, and those are two crowds of 53 and 45, never one
    of 98. Second, k is set by the <em>coarsest side channel</em>, not by the leaf count: any
    channel that partitions the pool &mdash; the fee payer, the deposit funder, timing &mdash;
    divides k, and one open channel pins it to 1 no matter how many notes are in the tree. That
    is why the number on the plate is one and not 47, and why A8 lists the channels rather than
    the leaves.
  </p>
</div>
'''),

    dict(no='A6', clock='', role='roadmap', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A6 &middot; what is in flight</p>
<h2>C7 does the work of two proofs, is measured, and is not deployed.</h2>
<p>
  It is on a plate because it is already measurable, not because it is scheduled. It merges the
  commitment derivation and the Merkle circuits so the note commitment never leaves the circuit
  as a public input.
</p>
<div class="scroll">
<table>
  <tr><th>Measurement</th><th>C7</th><th>What it replaces</th></tr>
  <tr><td class="k">Verifier cost, phase 1</td><td>878,756 CU</td><td>1,681,540 CU for the C1 and C3 pair, phase 1 only.</td></tr>
  <tr><td class="k">Verifier cost, phase 2</td><td>192,715 CU</td><td>&middot;</td></tr>
  <tr><td class="k">Proof on the wire</td><td>77,965 bytes</td><td>147,038 bytes for C1 plus C3 today: C1 at 27 queries, C3 at 22, both at ffps 16. A 1.9&times; cut, not the 3.3&times; some comments in this repo still claim from the pre-B4 sizes.</td></tr>
  <tr><td class="k">What the buyer actually pushes</td><td>Not measured for C7</td><td>A proof does not fit in one transaction: the deployed C1 plus C3 pair uploads in 74 to 145 <span class="hash">write_proof_chunk</span> transactions. Bytes are the unit we optimised. Transactions and seconds are the unit the buyer pays.</td></tr>
  <tr><td class="k">What it costs everything else</td><td>+3,232 to +3,930 CU</td><td>Phase 1 on C1 through C6. C0 went down 16 CU. Phase 2 moved by at most one unit.</td></tr>
</table>
</div>
<ul>
  <li><strong>Not deployed.</strong> Extend the verifier account <em>and</em> the pool account, which has zero spare room, then push the binary, then rebuild the WASM client. The client rebuild is deliberately blocked until the on-chain verifier answers, because a client that proves what the chain will not accept fails at the end of a 150 transaction upload.</li>
  <li>Put the compute unit harness back in CI. It was removed and nothing re-measures automatically today.</li>
  <li>External audit and mainnet are both unchecked on the public roadmap. They are listed, not scheduled.</li>
</ul>
'''),

    dict(no='A7', clock='', role='team', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A7 &middot; team</p>
<h2>The repository names one author, and we will not assert more than that.</h2>
<ul>
  <li>One human author on every commit in this repository, plus a deploy bot. That is the whole of what the history supports.</li>
  <li>Where the published packages carry an author field it reads "Protocol 01" or "Protocol 01 Team", and four carry none at all. That is a label chosen for npm, not a roster.</li>
  <li>The project renamed from Protocol 01 to Styx. The npm scope, the repository and about a hundred on-chain string literals still read <span class="hash">protocol-01</span>, which is why the demo plate installs <span class="hash">@protocol-01/merchant-sdk</span>. Those literals are frozen: renaming them moves funds to addresses nobody controls.</li>
  <li>Credentials and employers are not recorded in the repo, so they are not asserted here. Ask the presenter and get the answer from a person.</li>
</ul>
<div class="note">
  <p>
    This plate exists so that a jury asking about the team gets a straight answer in one line,
    instead of a slide of logos that has to be walked back.
  </p>
</div>
'''),

    dict(no='A8', clock='', role='limits', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A8 &middot; what this does not do yet</p>
<h2>The list a hostile reviewer would write, written first, by us.</h2>
<ul class="none">
  <li><strong>Devnet only.</strong> No mainnet deployment. Test value assets only, on Solana devnet and Starknet Sepolia.</li>
  <li><strong>Not audited.</strong> No external security audit has been performed.</li>
  <li><strong>Deposit to withdraw linkage is possible on four of the seven spends.</strong> The v3 withdrawal, the v3 subscription, the transfer and the split all republish the commitment their deposit already published &mdash; at instruction byte 80, 160, 80 and 80 respectively &mdash; so matching the two is trivial for an observer. The crowd of 45 unspent notes is a ceiling; the effective size today is one. C7 closes it for the withdrawal AND, since 27 August, for the subscription &mdash; both proven end to end on devnet, both publishing no commitment on the wire. Two of the three clients route to them: this web app and the extension. The phone still calls the v3 path, and the reason is not the one this plate used to give: the &ldquo;180&nbsp;s on-device proving&rdquo; figure was retracted the evening it was recorded (the real device number is C3 = 1,482&nbsp;ms; the 180&nbsp;s was a WebView hang). The actual blocker was upstream &mdash; the phone&rsquo;s WebView bridge had no spend entry point at all until 27 August, so it could not produce a circuit-7 proof to time.</li>
  <li><strong>A spend can be walked back to a wallet &mdash; on every path but one.</strong> An ephemeral key cannot pay a fee from nothing, so on the ordinary path a transfer funds it and another sweeps the residue, and both are public. <strong>Measured 28 August, that stopped being true of one instruction.</strong> <span class="hash">unshield_denominated_stark_v4_relayed</span> pays its submitter out of the protocol fee the pool already charges, so a stranger can afford to send the transaction and no lamport travels from the buyer to them. On spend <span class="hash">4KHpG7ka&hellip;</span> the buyer&rsquo;s address appears in the account keys of NONE of the 94 transactions the probe read across three surfaces, each read in full &mdash; probe P11, PASS, frozen as <span class="hash">verify/fixtures/v4-relayed</span> and replayed in CI. &#9888; Read the limits with it: this is one spend on devnet, not a product path &mdash; there is no button for it in the app, the relaying node is not hosted, and the fee payer of every OTHER spend still has a funding history. The payee also stays written in the clear at instruction byte 115, permanently, so it re-links the moment those funds move.</li>
  <li><strong>The proof is not a hiding object.</strong> Circuit C0's witness can be recovered from a single proof. Treat a proof as public data. This is why the word "zero-knowledge" is not on any plate.</li>
  <li><strong>A merchant's subscribers are publicly enumerable.</strong> One filtered <span class="hash">getProgramAccounts</span> returns every vault with its retailer, deposit, rate and schedule. What the design buys is narrower: no address can be re-derived to ask whether a given wallet subscribes. And two of the twenty-eight live vaults are legacy normal-mode: they name the subscriber's wallet in the clear, so for those two even that narrower claim does not hold. Re-counted on chain 26 August &mdash; 28 <span class="hash">SubscriptionVault</span> accounts, 2 with a <span class="hash">subscriber_pubkey</span> present; one of those two is the deployment wallet itself.</li>
  <li><strong>Client surfaces are proven by hash, not by execution.</strong> No proof has ever been produced from the extension or the phone against the deployed verifier.</li>
</ul>
'''),

    dict(no='A9', clock='', role='operational limits', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A9 &middot; the operational list</p>
<h2>The five questions a jury asks that are not about cryptography.</h2>
<ul class="none">
  <li><strong>One key can replace every program.</strong> All eighteen devnet deployments, superseded builds included, are upgradeable by a single key. No multisig, no timelock, none immutable. The deployed verifier's bytecode is also not proven to come from this repository. A multisig upgrade authority is a precondition of real money, not a nice-to-have.</li>
  <li><strong>A subscription cannot be renewed or cancelled.</strong> The vault is a one-way prepaid envelope: <span class="hash">claim_period</span> is the only exit, the two cancel instructions were removed, and nothing returns to the subscriber. No renew instruction exists, and the obvious implementation, reusing the note secret, collides the vault address and strands the second note.</li>
  <li><strong>The chain's own entitlement flag is wrong.</strong> <span class="hash">subscribe_private_stark.rs</span> writes <span class="hash">is_active = true</span> and no instruction ever writes false, so a merchant who reads the field instead of the SDK grants access to every expired subscriber. The SDK computes entitlement from the funding and the clock and is correct today. The field is not, and the fix is a program upgrade.</li>
  <li><strong>The relay operator sees what the chain does not.</strong> The deposit relay keys a rate limit on the client IP, and the site stores waitlist emails. Off-chain metadata is a trust assumption in the operator, not a proof.</li>
  <li><strong>Rent already spent is not recoverable.</strong> Proof buffer accounts hold rent the current close path cannot reclaim.</li>
</ul>
'''),

    dict(no='A10', clock='', role='the script', cap=None, seconds=0, spoken='', body='''
<p class="eyebrow">Appendix A10 &middot; the script</p>
<h2>180 seconds, 398 spoken words, 110 on screen.</h2>
<p>
  The deck was cut to a clock, so the clock is on every plate. At 145 words a minute, a plate
  gets what its badge says and not a word more. The full spoken text lives in
  <span class="hash">docs/deck/three-minute-script.md</span>.
</p>
<div class="scroll">
<table>
  <tr><th>Plate</th><th>Budget</th><th>Spoken</th><th>On screen</th></tr>
  <tr><td class="k">01 &nbsp; Title</td><td>0:10</td><td>23 words</td><td>12</td></tr>
  <tr><td class="k">02 &nbsp; The problem</td><td>0:20</td><td>48</td><td>16</td></tr>
  <tr><td class="k">03 &nbsp; The demo</td><td>1:00</td><td>120</td><td>4 plus the transcript</td></tr>
  <tr><td class="k">04 &nbsp; Where the market stops</td><td>0:25</td><td>56</td><td>24</td></tr>
  <tr><td class="k">05 &nbsp; What we bring</td><td>0:25</td><td>57</td><td>25</td></tr>
  <tr><td class="k">06 &nbsp; What a merchant gets</td><td>0:25</td><td>59</td><td>17</td></tr>
  <tr><td class="k">07 &nbsp; The ask</td><td>0:15</td><td>35</td><td>12</td></tr>
  <tr><td class="k">&nbsp; &nbsp; Slack</td><td>0:00</td><td>&middot;</td><td>15 s left for the demo to breathe</td></tr>
</table>
</div>
<div class="note">
  <p>
    One claim per plate. What is written under a headline is the evidence the presenter says out
    loud, not text for the room to read. The moment a plate carries two claims, the room reads
    the second while you are still saying the first.
  </p>
</div>
'''),
]
