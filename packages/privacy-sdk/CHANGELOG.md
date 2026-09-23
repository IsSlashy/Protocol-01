# Changelog — @protocol-01/privacy-sdk

## Unreleased (ships in 2.0.0, not yet published)

API break, on top of the 2.0.0 removals below. Every module that built
instructions for a program that is not deployed, or that the deployed program
does not register, is gone. Nothing in the repository imported any of them.

- Removed `ShieldModule` (`sdk.shield`, `./shield`): `shield`, `transfer` and
  `unshield` targeted `shield_stark`, `transfer_stark`, `unshield_stark`,
  `shield_denominated` and `unshield_denominated_stark`, none of which the
  deployed `zk_shielded` program registers. The refusal guard added for them
  earlier in this cycle went with the module.
- Removed `ConfidentialModule` (`sdk.confidential`, `./confidential`; zkspl
  `AY38smtd…` is not deployed), `StreamsModule` (`sdk.streams`, `./streams`;
  stream `C92xDDAt…` not deployed), `SubscriptionsModule`
  (`sdk.subscriptions`, `./subscriptions`; subscription `3eDvPJTK…` not
  deployed, subscriptions live in `zk_shielded` vaults) and `PayrollModule`
  (`./payroll`, built on streams).
- Removed `ComplianceModule` (`./compliance`, Groth16 with no deployed
  verifier), `AirdropModule` (`./airdrop`) and `OTCModule` (`./otc`), whose
  instructions exist in no program, and `TreasuryModule` (`./treasury`),
  which wrapped shield and compliance.
- Removed `LiquidityModule`, `P01_LIQUIDITY_PROGRAM_ID`, `InstantUnshieldFlow`,
  `buildInstantUnshield` and the rest of the instant-unshield exports: the
  `p01_liquidity` program they drove is deactivated. The refusal added for it
  earlier in this cycle (`LIQUIDITY_DISABLED`, code 2009) went with them.
- Removed the React hooks `useShield`, `useConfidential`, `useStreams` and
  `useSubscriptions`.
- Removed from `ProgramIds` and `PROGRAM_IDS`: `trustless`, `zkspl`, `stream`,
  `subscription`, `whitelist` and `bundler`. What remains: `zkShielded`,
  `relayer`, `registry`, `starkVerifier`.
- Removed the constants `SHIELD_FEE_BPS`, `UNSHIELD_FEE_BPS`, `MAX_FEE_BPS`,
  `FEE_WALLET`, `STARK_CIRCUITS` (use `STARK_CIRCUITS` from
  `@protocol-01/stark-prover`) and `COMPUTE_UNITS`; the seeds `STREAM`,
  `TRUSTLESS_POOL`, `CONFIDENTIAL_ACCOUNT` and `SUBSCRIPTION`.
- Removed the error codes 2001–2009, 4001–4005, 5001–5005, 6001–6004 and
  9001–9006, and the factories `PrivacyError.proofFailed`, `poolNotFound` and
  `nullifierSpent`. The numbers are not reused.
- Removed the types of the removed modules (shield, confidential, streams,
  subscriptions and their receipts, `EncryptedNote`, `PoolInfo`), the retired
  `MPC*` types, `Groth16Proof`, `ProofResult`, `StarkProofOutcome`,
  `StarkProofGenerator` and `ProverConfig`; the events `shield`, `unshield`,
  `transfer`, `stream:*`, `subscription:*` and `mpc:*`.
- Dependencies dropped: `@protocol-01/privacy-toolkit` (the package is
  deleted from the repository), `snarkjs`, `poseidon-lite`, `@coral-xyz/anchor`,
  `@solana/spl-token`, `@noble/post-quantum`, `bs58`.

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
