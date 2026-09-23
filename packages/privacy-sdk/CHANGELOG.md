# Changelog — @protocol-01/privacy-sdk

## Unreleased

- `shield`, `transfer` and `unshield` refuse before any proof request or RPC
  call: each targets an instruction the deployed `zk_shielded` program does not
  register (`UNREGISTERED_ZK_SHIELDED_INSTRUCTIONS`).
- Instant unshield and the liquidity pool are disabled against the deployed
  `p01_liquidity` program (`6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg`),
  whose reserve can be drained (audit v1 F27): `InstantUnshieldFlow`,
  `buildInstantUnshield`, `LiquidityModule.buildDepositIx`, `buildPrefundIx`
  and `buildSettleIx` throw `PrivacyError(LIQUIDITY_DISABLED)` (new code 2009)
  for that id. `buildWithdrawIx` still builds. `buildInstantUnshield` takes an
  optional third argument, the liquidity program id.
- README: status section; the network table now lists what is deployed
  (devnet only, nothing on mainnet).

## 2.0.0 — 2026-09-13

API break. On 2026-09-13 the founder had four programs closed on devnet with
`solana program close` (the ids can never hold a program again): `specter`
`FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL`, `p01_quantum_vault`
`9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv`, `p01_fee_splitter`
`UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM` and `p01_quantum_wallet`
`D7RBAFcMq2gGddwFvabZKuJB1eWZFvESVrcJ3i15FFtz`. Nothing in this SDK may send
an instruction to, or read the accounts of, a closed program, so:

- Removed `StealthModule` (`sdk.stealth`, `modules/stealth` entry point) and
  the React hook `useStealth`. Every one of its operations — `send`, `scan`,
  `claim`, the stealth PDA — went through the `specter` program.
- Removed `VaultModule` (`sdk.vault`, `modules/vault` entry point) and the
  React hook `useVault`: WOTS+ and hash-timelock vaults lived in
  `p01_quantum_vault`.
- Removed from `ProgramIds` and `PROGRAM_IDS`: `specter`, `feeSplitter`,
  `quantumVault`, and `arcium` (a placeholder since Arcium left the project;
  its own doc promised removal at the next major).
- Removed the types `StealthMetaAddress`, `StealthAddress`, `StealthPayment`,
  `StealthSendParams`, `StealthSendReceipt`, `StealthScanOptions`,
  `StealthClaimReceipt`, `VaultType`, `CreateVaultParams`,
  `VaultDepositParams`, `VaultWithdrawParams`, `VaultInfo`, `VaultReceipt`;
  the events `stealth:send`, `stealth:receive`, `stealth:claim`,
  `vault:create`, `vault:deposit`, `vault:withdraw`; the error codes 3001–3006
  and 7001–7005; the seeds `P01_WALLET`, `STEALTH`, `STEALTH_V2`,
  `FEE_CONFIG`, `WINTERNITZ_VAULT`, `HASH_VAULT`, `COMMIT_RECORD`; the
  compute-unit entries `STEALTH_SEND`, `STEALTH_CLAIM`.
- `PayrollModule.executeBatch` refuses, before any payment goes out, an
  employee without `useStream: true` or with a `st:…` meta-address: its direct
  leg was a stealth transfer through `specter`. Every payroll payment is a
  private stream.

Untouched, and worth knowing: `streams` (p01_stream), `liquidity`
(p01_liquidity), `subscriptions` (p01_subscription), `confidential` (zkspl)
and `whitelist` target programs that are NOT deployed on devnet either
(`solana account <id> --url devnet`, 2026-09-12); they were not part of this
change.

## 1.0.6 — 2026-09-12

- Reads transactions with `maxSupportedTransactionVersion: 1`: the proof
  uploads of the current `@protocol-01/stark-prover` travel as transaction-v1
  envelopes (SIMD-0385), and a reader pinned to version 0 skips them.
- `modules/instantUnshield.ts` is marked LEGACY in its header: it carries its
  own copy of the pre-2026-09 upload protocol (PDA buffer, 1,000-byte chunks).
  No app calls it. Proof upload and verification belong to
  `@protocol-01/stark-prover`'s `uploadAndVerify`, which the host-supplied
  `generateStarkProof` should use — see that package's CHANGELOG 0.2.0 for the
  verifier this pairs with (devnet slot 497235406).

## 1.0.5

Published before this changelog existed.
