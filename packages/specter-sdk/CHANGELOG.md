# Changelog — @protocol-01/specter-sdk

## 0.5.0 — 2026-09-13

BREAKING. The on-chain `specter` program
(`FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL`, devnet) was closed on
2026-09-13 on the founder's decision, together with `p01_quantum_vault`,
`p01_quantum_wallet` and `p01_fee_splitter`; nothing that ships sent them an
instruction. Every code path of this package that targeted that program is
removed rather than left pointing at a closed account:

- `sendPrivate`, `estimateTransferFee`, `SendOptions` (`transfer/send`);
  the whole `transfer/claim` module (`claimStealth`, `claimMultiple`,
  `getStealthBalance`, `canClaim`, `estimateClaimFee`, `closeStealthAccount`,
  `buildClaimProof`, `buildClaimProofV2`, `ClaimOptions`);
- `stealth/scan` (`StealthScanner`, `scanForPayments`, `createScanner`,
  `subscribeToPayments`) and `stealth/announcement-v2` (`buildInitStealthV2Ix`,
  `buildWriteKemChunkIx`, `buildKemChunkIxs`, `deriveAnnouncementPda`,
  `decodeStealthV2` and its size constants);
- the whole `streams` module and the `./streams` sub-path (`createStream`,
  `withdrawStream`, `cancelStream`, `pauseStream`, `resumeStream`,
  `getStream`, `getUserStreams`, `withdrawAllStreams`, `closeExpiredStream`,
  the rate and fee helpers) — its instructions lived in the same program;
- `indexing/stealth-indexer` (`StealthIndexer`);
- on `P01Client`: `scanForIncoming`, `subscribeToIncoming`, `sendPrivate`,
  `claimStealth`, `estimateFee`, `createStream`, `withdrawStream`,
  `cancelStream`, `getStream`, `getMyStreams`, `getProgramId`, `on`, `off`,
  and the `programId` option of `P01ClientConfig`;
- constants `PROGRAM_IDS`, `DEFAULT_PROGRAM_ID`, `MIN_STREAM_DURATION`,
  `MAX_STREAM_DURATION`, `MIN_STREAM_AMOUNT`, `STREAM_SEED`,
  `DEFAULT_SPLIT_COUNT`, `DEFAULT_SPLIT_DELAY`, `MIN_SPLIT_AMOUNT`,
  `PRIVACY_CONFIG`, `ACCOUNT_NAMES`, and the feature flags
  `ENABLE_MULTI_HOP`, `ENABLE_TOKEN_STREAMS`, `ENABLE_NFT_TRANSFERS`;
- types `StealthPayment`, `ScanOptions`, `PrivacyLevel`, `PrivacyOptions`,
  `TransferRequest`, `TransferResult`, `ClaimResult`, `Stream`,
  `StreamStatus`, `StreamCreateOptions`, `StreamWithdrawOptions`,
  `TransactionType`, `TransactionRecord` and the event types.

What stays, unchanged: wallet creation and import, the off-chain stealth key
math (`generate`, `derive`, `quantum`, `utils/crypto`), `sendPublic`, the
service registry and registry clients (`p01_registry`), the relay module
(`p01_relayer`), private subscriptions (`zk_shielded`), the STARK client
prover, the commitment indexer and the WOTS+ / hash-commitment helpers.
`scripts/sync-program-ids.ts` no longer emits a specter entry.

Measured after the cut: `vitest run` and `tsc --noEmit` in this package — the
counts are in the commit that ships this entry.

## 0.4.4 — 2026-09-12

- Rebuilt against `@protocol-01/stark-prover` 0.2.0, which `src/proving`
  inlines at build time: keypair proof buffers created in one transaction,
  transaction-v1 chunks (3,840 bytes, 21 transactions for a circuit-7 proof),
  merged verification phases where the budget allows, and the prover blob
  `0ad6d7f1…` that the verifier deployed on devnet on 2026-09-12 accepts.
- `wasm/` (published, gitignored) carries that same blob;
  `packages/stark-prover/scripts/stark-wasm-twins.mjs --check` passes over it.

## 0.4.3

Published before this changelog existed; carries the previous blob
(`36c1fd4e…`), which the current devnet verifier rejects.
