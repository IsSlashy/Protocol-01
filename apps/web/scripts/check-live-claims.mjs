#!/usr/bin/env node
/**
 * Sweep the LIVE site for claims the repository disproves.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE LEXICON TEST
 *
 * __tests__/lib/claims-lexicon.test.ts guards the two dictionaries, which is
 * where the overwhelming majority of copy lives. It cannot see a sentence typed
 * straight into a component. On 2026-08-16 exactly that was found:
 * app/terms/page.tsx said "zero-knowledge circuits" in its intellectual
 * property clause, and /terms is served to the public. A gate that only curled
 * / and /docs reported the site clean while a visitor could open a third page
 * and read the claim.
 *
 * So this sweeps what is actually served, over every public route, which is the
 * only measurement that cannot be fooled by where a string happens to be
 * declared. Run it against production after a deploy, or against any origin.
 *
 *   node scripts/check-live-claims.mjs
 *   node scripts/check-live-claims.mjs https://some-preview.vercel.app
 *   node scripts/check-live-claims.mjs --self-test
 *
 * Exits 0 when the site is clean, 1 on any hit or any route that fails to load.
 *
 * NOTE ON PREVIEW URLS: Vercel preview deployments answer 302 to a login page.
 * A sweep of a preview therefore measures a redirect, not the site, and would
 * report a clean zero for the wrong reason. Routes that do not answer 200 are
 * counted as FAILURES here for that exact reason -- silence must not read as
 * success.
 */

const DEFAULT_ORIGIN = "https://protocol-01.dev";

const ROUTES = [
  "/",
  "/app",
  "/card",
  "/careers",
  "/docs",
  "/explorer",
  "/extension",
  "/founder",
  "/licenses",
  "/parcours",
  "/privacy",
  "/roadmap",
  "/sdk-demo",
  "/terms",
  "/updates",
  "/waitlist",
];

/**
 * Each rule is a claim the repository measures to be false, in both languages.
 *
 * `allow` holds the exact substrings that make an otherwise-forbidden phrase
 * true in context. They are listed one by one with their reason, never as a
 * catch-all pattern: a rule with a loose escape hatch stops being a rule.
 */
const RULES = [
  {
    id: "zero-knowledge",
    // Seven of the eight circuits apply no trace blinding at all; `spend`
    // applies a coset LDE and 128 mask rows and is still not zero-knowledge,
    // because that buys underdetermination rather than secrecy.
    // Probe P3b of verify/p01-verify.mjs
    // carries the measurement: four C1 witnesses, the spend secret among them,
    // recovered from the published proof bytes in 5 ms. (This used to cite
    // stark/tests/zk_feasibility.rs, deleted in dc9dd515.)
    patterns: [/zero[-\s]?knowledge/gi, /divulgation nulle/gi],
    allow: [
      // Saying the property is NOT held is the whole point of the honesty pass.
      "not zero-knowledge",
      "pas à divulgation nulle",
      "no longer",
      // /parcours narrates the gap between what the README announced and what
      // actually runs. The claim appears there in order to be denied.
      "n'est pas ce qui tourne",
    ],
  },
  {
    id: "hidden-amounts",
    // Pools are fixed-denomination and a pool address derives from its
    // denomination, so the amount is public by construction.
    patterns: [
      /amounts?[^.<>]{0,40}\bhidden\b/gi,
      /\bhidden\b[^.<>]{0,40}amounts?/gi,
      /montants?[^.<>]{0,40}(masqués|cachés)/gi,
    ],
    allow: ["amounts are not hidden", "montants ne sont pas cachés"],
  },
  {
    id: "post-quantum-signatures",
    // The signature that pays is Ed25519 and stays Ed25519. Post-quantum is
    // true of the STARK proofs, of note encryption and of stealth addresses,
    // and false of transactions, payments and signatures.
    patterns: [
      /post[-\s]?quantum[^.<>]{0,30}(transaction|payment|signature)/gi,
      /(transaction|payment|signature)[^.<>]{0,30}post[-\s]?quantum/gi,
      /post[-\s]?quantique[^.<>]{0,30}(transaction|paiement|signature)/gi,
    ],
    allow: [
      // waitlist.projectNoteSignatures denies the property explicitly; it is
      // the model sentence the rest of the copy was rewritten against.
      "stay ed25519",
      "restent ed25519",
      "no protocol on this chain can offer",
      "aucun protocole sur cette chaîne",
    ],
  },
  {
    id: "untraceable",
    // A withdrawal republishes the commitment its deposit emitted, so the two
    // are pairable by anyone reading the chain.
    patterns: [/untraceable/gi, /unlinkable/gi, /intraçable/gi, /non liable/gi],
    allow: [
      "not yet unlinkable",
      "pas encore",
      "not unlinkable",
      // /updates lists what shipped and then withdraws the conclusion someone
      // might draw from it: "None of that makes a deposit and its withdrawal
      // unlinkable. The withdrawal republishes the deposit commitment."
      "none of that makes",
      "rien de tout cela",
    ],
  },
];

function scan(html) {
  // Strip HTML comments and inline JSON payloads before matching: Next.js
  // ships the whole dictionary inside __NEXT_DATA__/flight payloads on some
  // routes, and an unrendered key would otherwise count as a served claim.
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    // Decode the entities the renderer emits, BEFORE the allow-list is
    // consulted. Without this every exception containing an apostrophe is
    // unreachable: the first real sweep flagged /parcours for saying "preuve à
    // divulgation nulle ... Ce n&#x27;est pas ce qui tourne", which is the page
    // calling the claim false, and no allow entry could ever match `n&#x27;est`.
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  const hits = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      for (const m of visible.matchAll(pattern)) {
        const from = Math.max(0, m.index - 60);
        const context = visible.slice(from, m.index + m[0].length + 60).replace(/\s+/g, " ");
        if (rule.allow.some((ok) => context.toLowerCase().includes(ok.toLowerCase()))) continue;
        hits.push({ rule: rule.id, matched: m[0], context: context.trim() });
      }
    }
  }
  return hits;
}

async function selfTest() {
  // Control on the control. If these stop being caught, the sweep has become
  // decorative and every green run afterwards would mean nothing.
  const mustCatch = [
    ["<p>Zero-knowledge: Proofs reveal nothing beyond validity</p>", "zero-knowledge"],
    ["<p>Transaction amounts are hidden in shielded transfers</p>", "hidden-amounts"],
    ["<p>Les montants des transactions sont cachés</p>", "hidden-amounts"],
    ["<p>Post-quantum payments on Solana</p>", "post-quantum-signatures"],
    ["<p>Untraceable payments</p>", "untraceable"],
  ];
  // And these must NOT be caught, because they are the true sentences the
  // rules exist to protect. A guard that over-corrects gets switched off.
  const mustPass = [
    "<p>Not zero-knowledge today: a private witness has been recovered from the published proof bytes</p>",
    "<p>Amounts are not hidden: pools are fixed-denomination</p>",
    "<p>Transaction signatures are Ed25519 and stay Ed25519</p>",
    "<p>Post-quantum STARK proofs, stealth addresses and shielded pools</p>",
    "<p>Deposits and withdrawals are NOT yet unlinkable</p>",
    // The two the first real production sweep flagged wrongly. Both are pages
    // stating the claim in order to deny it, and the entity-encoded apostrophe
    // in the first is why the decode above exists. They stay here so a later
    // edit to the rules cannot silently start flagging honesty again.
    "<p>Le README annonce de la confidentialite par preuve a divulgation nulle. Ce n&#x27;est pas ce qui tourne.</p>",
    "<p>None of that makes a deposit and its withdrawal unlinkable. The withdrawal republishes the deposit commitment.</p>",
  ];

  let bad = 0;
  for (const [html, expected] of mustCatch) {
    const hits = scan(html);
    const ok = hits.some((h) => h.rule === expected);
    console.log(`${ok ? "PASS" : "FAIL"}  catches ${expected}: ${html.slice(0, 58)}`);
    if (!ok) bad++;
  }
  for (const html of mustPass) {
    const hits = scan(html);
    console.log(`${hits.length === 0 ? "PASS" : "FAIL"}  leaves alone: ${html.slice(0, 58)}`);
    if (hits.length) {
      bad++;
      hits.forEach((h) => console.log(`        false positive [${h.rule}] ${h.matched}`));
    }
  }
  console.log(bad === 0 ? "\nself-test OK" : `\nself-test FAILED (${bad})`);
  return bad === 0 ? 0 : 1;
}

async function sweep(origin) {
  console.log(`sweeping ${origin} over ${ROUTES.length} public routes\n`);
  let failures = 0;

  for (const route of ROUTES) {
    const url = `${origin}${route}`;
    let res;
    try {
      res = await fetch(url, { redirect: "manual" });
    } catch (err) {
      console.log(`FAIL  ${route.padEnd(20)} unreachable: ${err.message}`);
      failures++;
      continue;
    }

    if (res.status !== 200) {
      // Not a pass. A 302 to a Vercel login is the classic way a preview sweep
      // reports a clean zero while measuring nothing at all.
      console.log(`FAIL  ${route.padEnd(20)} HTTP ${res.status} (not measured)`);
      failures++;
      continue;
    }

    const hits = scan(await res.text());
    if (hits.length === 0) {
      console.log(`ok    ${route.padEnd(20)} clean`);
    } else {
      failures++;
      console.log(`FAIL  ${route.padEnd(20)} ${hits.length} claim(s)`);
      for (const h of hits) console.log(`        [${h.rule}] ...${h.context}...`);
    }
  }

  console.log(
    failures === 0
      ? `\nAll ${ROUTES.length} routes clean.`
      : `\n${failures} route(s) failed.`
  );
  return failures === 0 ? 0 : 1;
}

const arg = process.argv[2];
const code = arg === "--self-test" ? await selfTest() : await sweep(arg || DEFAULT_ORIGIN);
process.exit(code);
