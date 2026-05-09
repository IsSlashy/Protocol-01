Protocol 01, Privacy & Payments Layer for Solana

Protocol 01 is the privacy and payments layer Solana doesn't have yet. We ship a complete stack, post-quantum ZK-STARKs, stealth addresses, on-chain stealth relayer, service registry, confidential SPL, behind plug-and-play SDKs. Every flow exists in two parallel modes on the same rail: classic (transparent, fast, cheap) and private (STARK-shielded, unlinkable). Live on devnet across mobile, extension, and web.

Core tech. Winterfell STARK prover over Goldilocks with Poseidon hashing, 6 AIRs (shield, unshield, transfer, confidential balance, pool commitment, Merkle update), no trusted setup, hash-based, quantum-resistant. A native multi-circuit FRI verifier on Solana checks proofs in <1.4M CU. Hybrid stealth addresses combine X25519 + ML-KEM-768 (NIST PQC). A WOTS+ vault hedges against Ed25519 ever breaking. An on-chain relayer network (`p01_relayer`) with N-relayer failover and chunked submission breaks tx-graph links. Arcium MPC bridge handles multi-leg flows STARKs can't express.

Payments, one rail, two modes.
- Recurring (P2B): merchants publish on-chain offers; users subscribe in one tap. Private mode settles via shielded notes; cancellation re-denominates refunds into private notes, no clear balance ever touches the wallet.
- P2P: send SOL or any SPL with a single STARK proof, note to note, one tx.
- P2B checkout: `merchant-sdk` invoices, buyer settles with a shielded note, merchant receives clean funds.
- B2B: confidential SPL + liquidity pool + Arcium MPC for settlement, netting, treasury.

Every payment pays the same automatic on-chain fee (0.3 to 0.5%), one protocol, one fee rail.

Shipped. 13 Solana programs, 6 STARK AIRs, 8+ TypeScript SDKs, 3 clients (Android, Chrome MV3, Next.js), plus Mugen, a no-KYC fiat-to-crypto P2P exchange built on the stack. Live devnet demo. Solo built in ~100 days.

Devnet program IDs.

p01_stark_verifier: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs / zk_shielded: GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c / p01_zkspl: EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah / specter: 2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp / p01_trustless: FnTmMxsNx5yQ4nDxiUq7HKLyb6Hwi5Wb5D71Zu69i43Q / p01_relayer: 2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW / p01_quantum_vault: HazoS6VKk4fqzjJg2yNYSPYTSq8yEHm2EZyb23seTh7o / p01_registry: QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB / p01_arcium: FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT / p01_fee_splitter: UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM
