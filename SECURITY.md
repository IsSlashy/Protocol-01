# Security Policy

## Status of this project

Protocol 01 is **pre-mainnet**. Everything currently deployed runs on **Solana devnet** and **Starknet
Sepolia**, with test-value assets only. Do not use it to hold anything you would mind losing.

The privacy properties this codebase provides today are narrower than the word "privacy" usually
implies. The `HonestyBadge` in the app and the per-feature notes in the code state what is and is not
delivered. Where they disagree with marketing copy, **the code is the source of truth** — please report
the discrepancy as a bug.

## Reporting a vulnerability

Email **amirramy.chatbi@gmail.com** with `SECURITY` in the subject line.

Please include what you need to make the issue reproducible: affected file and line, the sequence that
triggers it, and a devnet transaction signature if one exists. If you would rather not send details by
email first, send a short description and we will arrange another channel.

Please do **not** open a public GitHub issue for a vulnerability that could move funds or deanonymise a
user, even on devnet.

Expect an acknowledgement within 72 hours. Because this is a solo project, a fix may take longer than
an acknowledgement — you will be told which.

## Scope

In scope:
- On-chain programs under `programs/`
- The STARK prover and AIRs under `stark/`
- Client key handling, note handling and proof submission in `apps/` and `packages/`
- Anything where the shipped behaviour contradicts a stated privacy or security claim

Out of scope:
- Devnet RPC rate limits and availability
- Findings that require a compromised device or a malicious dependency already installed by the user
- Marketing copy on the website that is merely vague rather than false (report false ones — those are
  in scope and treated seriously)

## Disclosure

Security analysis, remediation plans and unfixed-issue tracking are kept **outside this repository**
while they are open, and published once the corresponding fix has shipped and been verified on-chain.
If a document referenced from a code comment is not present in `docs/`, that is why.

We will credit reporters who want credit, and respect the wishes of those who do not.
