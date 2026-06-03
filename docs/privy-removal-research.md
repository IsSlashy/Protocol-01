I have everything needed. Here is the consolidated de-risking report.

---

# Wallet-architecture de-risk: deterministic spending-key derivation

## Repo context (what already exists)
- The extension already derives privacy material **deterministically from a 32-byte `walletSeed`** (HKDF/SHA-256), not from per-call signatures. See `D:\Protocol-01\apps\extension\src\shared\services\noteCrypto.ts:71` (`deriveNoteEncryptionKeys`), `D:\Protocol-01\apps\extension\src\shared\services\denominatedPool.ts` (`deriveNoteMaterial`), and `D:\Protocol-01\apps\extension\src\shared\store\denominatedPool.ts:209` (`getWalletSeed` = `_keypair.secretKey.slice(0,32)`, mirrors mobile).
- `walletSeed` only resolves for **local/seed wallets** today. For Privy it throws unless the note-seed ceremony ran (`denominatedPool.ts:212`). For QR/watch-only it can't sign at all (known bug `bug-qr-wallet-no-signer-2026-06-01`).
- `useWalletSigner().signMessage` (`authAdapter.ts:162`) already exists and routes to Privy `signMessage` or tweetnacl on the local secret key. So a "sign a fixed message -> sha256 -> seed" path is wireable, but its portability depends entirely on the findings below.

## 1. LEDGER signMessage (off-chain message signing)
- **The Ledger Solana device app supports off-chain message signing**, introduced in **Solana app v1.3.0** (UTF-8 messages additionally require the **"Allow blind sign" toggle ON**). The app only became spec-correct (Anza OffchainMessage) at **v1.8.0**; **versions < 1.8.0 are effectively broken / disabled** for this. ([Anza off-chain proposal](https://docs.anza.xyz/proposals/off-chain-message-signing), [Ledger Solana signer](https://developers.ledger.com/docs/device-interaction/references/signers/solana), [wallet-adapter PR #1094](https://github.com/anza-xyz/wallet-adapter/pull/1094))
- **Constraints (sRFC-38 / Solana off-chain message spec):** UTF-8 encoded; hardware-wallet-signable cap is **1232 bytes**; "clear-signable" requires **printable ASCII only (0x20â€“0x7e)** â€” anything else is blind-sign only and needs the toggle. V1 header (sRFC 38) needs device app **1.14+**. ([sRFC 38](https://github.com/solana-foundation/SRFCs/discussions/3), [solanakit offchain messages](https://www.solanakit.com/docs/concepts/offchain-messages))
- **CRITICAL â€” dapps cannot reach it through Phantom:** Phantom returns **"Signing off-chain messages with Ledger is not yet supported"** (and/or a spurious 4001 "User rejected" even after Approve). This is long-standing and still the case. So a browser-extension dapp using the injected Phantom provider **cannot** get a Ledger `signMessage`. ([phantom/sandbox#14](https://github.com/phantom/sandbox/issues/14), [solana#35583](https://github.com/solana-labs/solana/issues/35583), [Ledger support](https://support.ledger.com/article/Unable-to-sign-off-chain-Message-with-Ledger-Solana-wallet-created-in-third-party-wallets))
- **Solflare** does expose a typed `signMessage(Uint8Array, 'utf8'|'hex')`, and there has been integration work to plumb the Ledger off-chain flow, but **Ledger-via-third-party-wallet off-chain signing remains flaky/often unavailable**; do not assume it works for all Solflare+Ledger users. ([Solflare signMessage](https://docs.solflare.com/solflare/technical/deeplinks/provider-methods/signmessage), [wallet-adapter#800](https://github.com/solana-labs/wallet-adapter/issues/800))

## 2. DETERMINISM of `signMessage`
- **Plain ed25519 (RFC 8032) is deterministic**: nonce = `H(key, message)`, so software signers (Phantom/Solflare embedded keys, tweetnacl) produce **identical bytes for the same key+message every time** â‡’ `sha256(sig)` is stable across calls/devices/wallet brands **for the same private key**. ([Phantom sign-a-message](https://docs.phantom.com/solana/signing-a-message), [EdDSA/RFC 8032](https://en.wikipedia.org/wiki/EdDSA), [RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032))
- **Hardware/MPC caveat â€” NOT guaranteed deterministic:** Some HSM/threshold (TSM/MPC) and even some hardware-wallet implementations **deliberately sample a fresh random nonce** ("hedged" signatures) instead of RFC-8032 derivation, producing **different signatures for the same message+key**. This breaks any `sha256(sig)`-as-seed scheme on those signers. ([Blockdaemon TSM EdDSA](https://builder-vault-tsm.docs.blockdaemon.com/v70/docs/key-derivation-eddsa), [Soatok hedged signatures](https://soatok.blog/2020/05/03/hedged-signatures-with-libsodium-using-dhole/))
- **Bottom line:** determinism is safe to rely on **only for pure-software ed25519 signers**. Do **not** rely on it for Ledger/MPC.

## 3. SENTINEL-TRANSACTION fallback (single Memo ix, fixed blockhash, never broadcast)
- **Will a wallet sign it?** Phantom/Solflare `signTransaction` will sign arbitrary bytes including a Memo-only tx, but they **simulate/preview** and an **old/invalid sentinel blockhash triggers loud "this transaction will likely fail / Blockhash not found" warnings** (Solflare previews outcomes; Phantom flags simulation failure). Users are trained to bail on these â€” high abandonment, poor UX, and some flows hard-block. ([Phantom errors](https://docs.phantom.com/solana/errors), [Blockhash not found](https://solana.stackexchange.com/questions/295/transaction-simulation-failed-blockhash-not-found), [Magic Eden tx errors](https://community.magiceden.io/learn/solana-transaction-errors))
- **Ledger:** signing a tx works, and the Memo would render only if the **Solana app can clear-sign that instruction**; otherwise it's **blind-sign** (toggle required) showing an opaque hash. This is *more* reachable through Phantom than off-chain `signMessage` (the tx path isn't blocked), so a sentinel **transaction** is the one mechanism that actually reaches Ledger via Phantom.
- **Determinism of the resulting signature:** identical only **for software signers** (same key+bytes â‡’ same sig). For Ledger/MPC it inherits the **same non-determinism risk as point 2** â€” so the sentinel-tx does **not** rescue determinism on hardware. It only rescues *reachability*.
- **Verdict on sentinel-tx:** It's a **reachability workaround, not a determinism guarantee.** It is genuinely needed only for the narrow case "I must get *some* signature out of a Ledger-behind-Phantom user," and even then the output may be non-deterministic. It is **not** a good universal key-derivation primitive.

## 4. MOBILE
- **Android (MWA, `@solana-mobile`)**: `signMessages` / `signMessagesDetached` is a **first-class MWA method** (MWA 2.0 spec), supported on Android + Android Chrome mobile-web, across the Kotlin SDK and RN/Flutter/Unity ports. Deterministic if the wallet's underlying signer is software ed25519. ([MWA 2.0 spec](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html), [Using MWA](https://docs.solanamobile.com/android-native/using_mobile_wallet_adapter))
- **iOS**: **MWA does not work on iOS** (it relies on persistent websocket/background sockets iOS forbids). iOS must use **Phantom universal-link/deeplink**, and Phantom's deeplink `signMessage` on iOS has reported **`-32603` failures** â€” unreliable. The viable iOS path is deeplink `signTransaction`/`signAndSendTransaction`, or a Safari Web Extension. ([Solana Mobile iOS signing](https://docs.solanamobile.com/blog/ios-wallet-signing), [phantom#359](https://github.com/orgs/phantom/discussions/359), [Phantom deeplinks](https://phantom.com/learn/blog/the-complete-guide-to-phantom-deeplinks))

---

## RECOMMENDATION â€” deterministic spending-key derivation per wallet kind

**Do not adopt a single universal method, and do not build the protocol around `signMessage` or a sentinel-tx.** A unified `signMessage`-derived seed fails on exactly the wallets you most need to support correctly (Ledger-behind-Phantom = blocked; Ledger/MPC = possibly non-deterministic; iOS Phantom = flaky). Tier it instead â€” which matches what the repo already does with `walletSeed`:

- **Seed / local wallet (the current default):** derive `walletSeed` **directly from the secret-key material** â€” `HKDF(secretKey[0:32], domain)` â€” exactly as today (`denominatedPool.ts` `getWalletSeed`, `noteCrypto.ts` `deriveNoteEncryptionKeys`). Fully deterministic, fully offline, fully portable for the same recovery seed. **Keep this; it's the gold path.** Make it the canonical method whenever raw key/seed is available (seed import, email/Privy embedded once exported, MWA-with-embedded-key).

- **Software-injected wallet (Phantom/Solflare extension, software key):** use a **deterministic `signMessage`** over a fixed domain-separated ASCII string, then `spendingSeed = HKDF(sha256(signature), domain)`. Deterministic and portable **only because the signer is software ed25519** (point 2). Constraints: keep the message **printable ASCII, < 1232 bytes**, domain-separated and human-readable. This is the standard "Sign-In-with-Solana"-style ceremony and is safe here. **Cache the derived seed** (as the code already does for Privy/ZK seeds, `shielded.ts:481`) so you sign once.

- **Hardware wallet (Ledger):**
  - Through **Phantom**: off-chain `signMessage` is **blocked** â€” do not depend on it.
  - Through **Solflare**: off-chain `signMessage` *may* work but is unreliable across versions; don't make it the only path.
  - **Do not derive a long-lived spending key from any Ledger signature** â€” determinism is not guaranteed across firmware/transport (point 2/3). Instead, treat Ledger as a **transaction co-signer over a long-lived, locally-generated-and-encrypted spending key** (generate a random 32-byte seed in the extension, encrypt it at rest, and have the user authorize spends by signing the actual on-chain tx). This sidesteps both the reachability block and the non-determinism. The **sentinel-tx is only worth keeping as a last-resort reachability shim** if you ever truly need a Ledger-derived secret, and you must then **verify the returned signature is reproducible on that device before trusting it** as a seed.

- **Mobile:** Android use **MWA `signMessage`** (deterministic for software signers, same ASCII-domain message as the extension â‡’ **same key cross-device** for the same wallet). iOS: avoid Phantom deeplink `signMessage` (`-32603`); prefer seed/MWA-embedded path, or fall back to a tx-based authorization like Ledger.

**Portability invariant:** "same user â†’ same key everywhere" holds **only** when the underlying secret is identical AND derivation is deterministic. That is guaranteed for the **seed/local path** (use it whenever the raw key is reachable) and for **software-`signMessage` over a fixed ASCII domain string** (Phantom/Solflare software + Android MWA all yield the same sig â‡’ same key). It is **not** guaranteed for Ledger or MPC â€” those must use the random-local-seed-+-tx-cosign model rather than signature-derived keys.

**Decisive answer on the sentinel-tx:** Not needed as a key-derivation primitive, and not safe as one. Keep the seed-direct path as primary, software-`signMessage` for injected/mobile, and a locally-generated encrypted spending key (Ledger co-signs txs) for hardware. Reserve the sentinel-tx purely as an optional Ledger reachability fallback, with a per-device reproducibility check before trusting its output.

Relevant repo files: `D:\Protocol-01\apps\extension\src\shared\services\noteCrypto.ts`, `D:\Protocol-01\apps\extension\src\shared\store\denominatedPool.ts`, `D:\Protocol-01\apps\extension\src\shared\store\authAdapter.ts`, `D:\Protocol-01\apps\extension\src\shared\services\stealth.ts`, `D:\Protocol-01\apps\extension\src\shared\store\shielded.ts`.

Sources:
- [Anza off-chain message signing proposal](https://docs.anza.xyz/proposals/off-chain-message-signing)
- [Ledger Solana Signer Kit](https://developers.ledger.com/docs/device-interaction/references/signers/solana)
- [Ledger support: unable to sign off-chain message in third-party wallets](https://support.ledger.com/article/Unable-to-sign-off-chain-Message-with-Ledger-Solana-wallet-created-in-third-party-wallets)
- [wallet-adapter PR #1094 (enable Ledger message signing)](https://github.com/anza-xyz/wallet-adapter/pull/1094)
- [wallet-adapter #800 (unable to sign off-chain with Ledger)](https://github.com/solana-labs/wallet-adapter/issues/800)
- [phantom/sandbox#14 (signMessage with Ledger not working)](https://github.com/phantom/sandbox/issues/14)
- [solana#35583 (Phantom can't sign message through Ledger)](https://github.com/solana-labs/solana/issues/35583)
- [sRFC 38 offchain message v1](https://github.com/solana-foundation/SRFCs/discussions/3)
- [solanakit offchain messages](https://www.solanakit.com/docs/concepts/offchain-messages)
- [Phantom: sign a message](https://docs.phantom.com/solana/signing-a-message)
- [Solflare signMessage](https://docs.solflare.com/solflare/technical/deeplinks/provider-methods/signmessage)
- [EdDSA (Wikipedia)](https://en.wikipedia.org/wiki/EdDSA) / [RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032)
- [Blockdaemon TSM EdDSA key derivation (random nonce)](https://builder-vault-tsm.docs.blockdaemon.com/v70/docs/key-derivation-eddsa)
- [Soatok: hedged signatures](https://soatok.blog/2020/05/03/hedged-signatures-with-libsodium-using-dhole/)
- [Phantom error codes](https://docs.phantom.com/solana/errors) / [Blockhash not found](https://solana.stackexchange.com/questions/295/transaction-simulation-failed-blockhash-not-found)
- [MWA 2.0 spec](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html) / [Using MWA (Android)](https://docs.solanamobile.com/android-native/using_mobile_wallet_adapter)
- [Solana Mobile: iOS wallet signing (MWA not supported on iOS)](https://docs.solanamobile.com/blog/ios-wallet-signing)
- [phantom discussion #359 (-32603 signMessage iOS deeplink)](https://github.com/orgs/phantom/discussions/359)
