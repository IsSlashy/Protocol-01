Confirmed: `rollupOptions` has NO `input` array â€” crxjs derives inputs purely from the manifest. A standalone `connect-ledger.html` not referenced in the manifest would NOT be emitted (#9 real). The hash-route-in-popup.html approach is the correct resolution.

I now have full ground truth on all 17 findings. All adversarial findings that I checked are confirmed real against the live code. I have everything needed to write the authoritative spec.

---

# AUTHORITATIVE IMPLEMENTATION SPEC â€” Device Pairing + Ledger Hardware (Protocol-01)

Status: lead-architect synthesis. Verified against live repo `D:\Protocol-01` on 2026-06-03. All 17 adversarial findings independently confirmed against actual code (citations inline). This spec OVERRIDES the three input specs wherever they conflict with the findings.

## 0. THE LOAD-BEARING INVARIANT (read first â€” resolves Findings #1, #6, #7, #15)

There is **one canonical "spending seed" per wallet, and it is the RAW 32 bytes**, NOT an HKDF sub-key. Verified live:

- Extension denominated: `getWalletSeed()` returns `keypair.secretKey.slice(0,32)` raw (`signer.ts:58`, `denominatedPool.ts:215`), fed straight to `deriveNoteMaterial`/`noteCrypto.deriveNoteEncryptionKeys` (which apply their OWN HKDF internally, with IKM = the raw slice).
- Extension shielded: `getSeedPhrase()` hex-encodes the raw slice (`shielded.ts:454`), and `zk.ts deriveSpendingKey` does `SHA-256(seedHex + ':spending_key')` (`zk.ts:222`). A THIRD derivation, also keyed on the raw slice.
- Mobile: `deriveLocalNoteSeed()` returns the raw slice (`wallet.ts:324`); `getSpendingSeed()` returns that; `denominatedPoolStore.ts:833,882` reads the raw slice directly.
- `deriveP01IdentityFromSeed` (`deriveIdentity.ts:88`) runs `HKDF(seed, salt='protocol01:hkdf:v1', info='p01:spend:v1')` and **has ZERO callers in the live note pipelines** (dead code for the SDK's separate identity API).

**Decree (canonical):** The hardware spending seed is a CSPRNG 32-byte value that is passed to the SAME consumers, in the SAME position, as the local raw slice is passed today. **Do NOT pre-run `deriveP01IdentityFromSeed` on it.** All three input specs are WRONG on this point and are corrected here. The hardware seed flows:
- denominated â†’ as `walletSeed` arg to `deriveNoteMaterial` / `deriveNoteEncryptionKeys` (raw)
- shielded â†’ hex-encoded, into `zk.ts initialize()` so `SHA-256(hex+':spending_key')` runs over it (raw)

This is the only way a hardware wallet's notes are self-consistent across both subsystems. A cross-subsystem parity test gates this (PLAN step S0-T1).

---

## 1. FINAL DESIGN

### 1A. DEVICE-TO-DEVICE PAIRING (extension â‡„ mobile, bidirectional)

**Goal:** move the BIP39 mnemonic from a device that has the wallet (SENDER) to an empty device (RECEIVER), so both derive identical Ed25519 keypair AND identical raw `noteSeed = secretKey.slice(0,32)`. The mnemonic is the only payload â€” it deterministically regenerates everything (transparent + all three ZK derivations). NEVER in cleartext in any QR/clipboard/log/relay.

**Transport:** 2-QR, no network. Camera = the authenticated out-of-band channel. Copy-paste fallback when one device lacks a camera (extension on a laptop = the common case; recommended posture: extension shows QR#1 / pastes QR#2, phone does all camera work).

**Crypto core:** reuse `noteCrypto.ts`'s hybrid box (X25519 + ML-KEM-768 â†’ HKDF-SHA256 â†’ XSalsa20-Poly1305), lifted into `packages/privacy-sdk/src/pairing/box.ts` so both apps share ONE byte-identical implementation. The pairing box is a **hardened sibling** of `noteCrypto`, not a verbatim copy â€” it fixes the cross-binding and low-order gaps (below).

#### Handshake

**QR#1 â€” RECEIVER shows, SENDER scans** (receiver's fresh ephemeral receive bundle):
```
p01pair1:<base64(
  version(1)=0x01 â€– x25519Pub(32) â€– kemPub(1184) â€– pairingNonce(16) â€– expiryUnixSecs(8 BE)
)>
```
Receiver generates a FRESH ephemeral hybrid keypair per ceremony (`nacl.box.keyPair()` + `ml_kem768.keygen(crypto.getRandomValues(64))`) â€” NOT seed-derived (forward secrecy; receiver is empty). â‰ˆ1655 base64 chars.

**SAS confirmation (between frames) â€” see MITM defense below.**

**QR#2 â€” SENDER shows, RECEIVER scans** (encrypted mnemonic):
```
payload = version(1) â€– pairingNonce(16) â€– timestamp(8) â€– walletKind(1)=0x01 â€– mnemonicLen(1) â€– mnemonicUtf8(N)
blob    = encryptToPairingBundle(receiverBundle, payload)
        = p01pairenc1:<base64(ephX25519Pub(32) â€– kemCiphertext(1088) â€– nonce(24) â€– ct)>
```
Receiver decrypts with its ephemeral secret keys, verifies `pairingNonce` echo + `now < expiry` + BIP39 checksum, then imports. â‰ˆ1730 base64 chars â€” single frame for a 12/24-word mnemonic.

Distinct prefixes `p01pair1:` / `p01pairenc1:` keep pairing blobs OFF the `p01enc1:` value-note import path.

#### MITM defense â€” SAS over BOTH frames (Finding #1, #2 accepted)

The input pairing spec's SAS hashed only QR#1 â€” **rejected**. Corrected derivation, computed identically on both devices over the full transcript:
```
transcript = "p01-pair-v1"
   â€– x25519Pub(32) â€– kemPub(1184)        // receiver bundle, EXACTLY as scanned/generated
   â€– pairingNonce(16) â€– expiryUnixSecs(8)
   â€– ephX25519Pub(32) â€– kemCiphertext(1088)   // QR#2 cross-binding (Finding #1)
sas = (BE_uint(sha256(transcript)[0..4]) mod 1_000_000)   // 6 digits, zero-padded
```
Because the SAS now binds the QR#2 ephemeral material, a MITM cannot swap EITHER frame without changing the SAS. Both apps render `123 456` with "Do these match on both devices?" â†’ two buttons. Sender's "match" unlocks QR#2 render; receiver's "match" arms its scanner. Mismatch on either side wipes ephemeral keys + aborts.

**Sequencing note:** SAS includes QR#2's ephemeral pubkey, so QR#2 must be built (encryption performed) before the SAS can display on the sender. Flow: sender scans QR#1 â†’ sender encrypts (produces QR#2 + its ephemeral material) â†’ BOTH show SAS (receiver computes it from the scanned-back ephemeral material embedded as a tiny SAS-commit, OR the two-scan path: receiver scans QR#2 first into a "verify" buffer, computes SAS, and only commits the decrypt after the match tap). The two-scan path is cleaner: **QR#2 is scanned into a hold buffer; SAS shown; on "match", decrypt proceeds.** One-way-scan/paste path: the receiver must TYPE the 6 digits the sender shows (Finding #1 â€” a paste-only tap is downgraded; force entry).

#### Hardened pairing box (Findings #2 accepted)

`box.ts` differs from `noteCrypto.ts` in three ways:
1. **HKDF salt binds both pubkeys + KEM ciphertext + nonce** (not just the static recipient x25519Pub): `salt = sha256(ephX25519Pub â€– x25519Pub â€– kemPub â€– kemCiphertext â€– nonce)`. Domain string `p01-pair-enc-hybrid-v1`.
2. **Reject low-order/all-zero X25519** on both encrypt and decrypt: after `nacl.scalarMult`, throw if the result is all-zero (defeats an attacker-supplied QR#1 forcing a known classical secret).
3. Explicit-ephemeral-keys decrypt `decryptWithEphemeral(keys, blob)` â€” `noteCrypto.decryptNote` re-derives from `walletSeed`; pairing keys are random/in-memory.

#### Replay/expiry/one-shot (Finding #4 accepted)

- Ephemeral keys single-use, in component state only, `fill(0)` on success/cancel/expiry.
- TTL `expiry = now+90s`, embedded AND echoed; receiver rejects past expiry. **Clock-rollback caveat:** wall-clock expiry is UX-grade only â€” the real guarantee is the **consumed-flag + used-nonce set**: the receiver records the `pairingNonce` of any consumed QR#1 and refuses a second decrypt under the same ephemeral key.
- Nonce echo binds QR#2 to QR#1 â€” defeats "film QR#2, replay to a different empty device" (that device generated a different nonce).
- Nothing persisted until receiver successfully decrypts AND imports.

#### What is / is NOT transferred (Findings #3 accepted)

Transferred (encrypted only): BIP39 mnemonic, `walletKind='seed'` tag, nonce/timestamp/version.
NOT transferred: NO hardware/Ledger seed (pairing refuses to START as sender when active wallet is `kind:'hardware'` â€” it has no mnemonic); NO password/passwordHash (each device sets its own unlock secret); NO note data (each device rescans chain).

**Zeroization honesty (Finding #3):** stop promising mnemonic zeroization â€” a JS string is immutable + GC-managed (`wallet.ts importWallet`, mobile `importWallet`). We CAN `fill(0)` the decrypted payload Uint8Array and ephemeral key buffers; we CANNOT scrub the derived string. Forbid clipboard for the raw phrase. Set `FLAG_SECURE` (mobile) on the QR#1/QR#2/SAS screens; on extension the connect tab is already screenshot-restricted by the existing screenshot-prevention hardening.

#### Pairing invariant (Finding #15 accepted)

Document and TEST: "the shielded ZK identity is a deterministic function of the mnemonic/`secretKey[0..32)`, byte-identical across clients; pairing carries NO per-device ZK seed." A cross-client parity test gates this so a future HKDF-identity migration cannot silently desync paired devices (PLAN step S0-T1 covers it jointly with Â§0).

---

### 1B. LEDGER â€” EXTENSION (WebHID, Chromium-only)

**Division of labor (hard constraint, Â§0):** Ledger co-signs the on-chain tx ONLY. The ZK spending seed is a separate CSPRNG 32-byte value, encrypted at rest, fed RAW to the note pipelines (Â§0). Two keys, one wallet. No off-chain `signMessage` (`Signer{kind:'hardware'}` throws `LedgerNoMessageSigningError`).

**Transport (verified-correct, Finding #17):**
- WebHID needs NO manifest permission, NO manifest key. Do not touch `manifest.json` `permissions`. CSP `script-src 'self' 'wasm-unsafe-eval'` is fine.
- `navigator.hid.requestDevice()` CANNOT run in the SW (no gesture/DOM), CANNOT run in offscreen (no HID Reason, non-interactive), MUST NOT run in an iframe (permissions-policy `hid` block â€” MetaMask #12257), and MUST NOT run in the toolbar popup (focus-loss death).
- **Run on a dedicated full extension TAB.** RESOLUTION of Finding #9 (crxjs contradiction): do NOT add a standalone `connect-ledger.html` (crxjs derives rollup inputs from the manifest; an unreferenced HTML is not emitted â€” verified: `vite.config.ts:72` `rollupOptions` has no `input`). Instead render `ConnectLedger` as a **hash route inside the existing `popup.html` SPA**, opened in a tab via `chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '#/connect-ledger' })`. Zero new HTML entry, zero manifest change. (Same pattern the pairing flow uses for `PairDevice`.)
- Packages: `@ledgerhq/hw-transport-webhid` (primary) + `@ledgerhq/hw-transport-webusb` (fallback) + `@ledgerhq/hw-app-solana` + `@ledgerhq/errors`. Gate UI on `TransportWebHID.isSupported()`. One long-lived transport on the tab; never create/destroy per call (Brave #19480 flicker). Pin current versions; device-test (Stax/Flex silent `create()` failures, ledger-live #7611).

**Signing (the footgun, Finding #13 sequencing accepted):**
```
tx.recentBlockhash = freshBlockhash; tx.feePayer = ledgerPubkey;
const msg = tx.compileMessage().serialize();      // MESSAGE bytes, not a serialized Transaction
const { signature } = await solanaApp.signTransaction(path, msg);
tx.addSignature(ledgerPubkey, signature);
```
**Ordering (Finding #13):** build commitment â†’ generate STARK proof (~2 min, runs in offscreen doc) â†’ assemble full ix set â†’ THEN fetch a FRESH blockhash â†’ `compileMessage` â†’ only THEN prompt the Ledger. The HID session lives on the connect tab and must survive the proof window; the offscreen proof-runner hands the finalized message to the tab via SW message-passing, and the device is prompted only after the proof is ready. Add blockhash-staleness re-sign.

**Blind-sign (P01 blocker):** P01 pool ix are custom-program â†’ `0x6808 BLIND_SIGNATURE_REQUIRED` unless on-device "Allow blind sign" is on. Pre-flight `getAppConfiguration().blindSigningEnabled`; if false, gate with a one-time explainer ("Open Solana app â†’ Settings â†’ Allow blind sign"). Catch `0x6808` (`StatusCodes` from `@ledgerhq/errors`) as fallback. Lives in `LedgerReviewModal`, shown before every device co-sign.

**ZK identity + backup (Â§0, Finding #11 corrected):** CSPRNG 32-byte seed â†’ AES-GCM at rest (`crypto.ts encrypt`, PBKDF2 bumped to 600k â€” Finding #4) under `chrome.storage.local` key `p01_ledger_spend_seed_<pubkey>`. Decrypt for proving, `fill(0)` after. Fed RAW to `deriveNoteMaterial`/`deriveNoteEncryptionKeys` AND hexâ†’`zk.ts initialize` (NOT `deriveP01IdentityFromSeed`). Opt-in encrypted backup (`p01id1:` blob) is near-mandatory: the Ledger phrase does NOT regenerate this random seed â†’ storage wipe = total note loss. Prompt on connect + re-prompt on first shield.

### 1C. LEDGER â€” MOBILE (BLE, Nano X only)

**Transport:** `@ledgerhq/react-native-hw-transport-ble` + `@ledgerhq/hw-app-solana` + `@ledgerhq/errors`. RN `0.81.5` / ble-plx `^3.5.1` verified (NOT the crashy 0.81.4 â€” Finding #17). All BLE native config (Android perms + iOS Info.plist + ble-plx Expo plugin) already present â€” NO new native config. Nano X only (S/S Plus have no BLE; capability-gate).

**BleManager coexistence (Finding #12 â€” injection demoted to fallback):** the "share the manager" plan is UNVERIFIED against the (uninstalled) Ledger transport's real API. **PRIMARY mechanism = strict mutual exclusion via a shared async mutex `bleLock`.** Both note-sharing (`services/sharing/transport/ble.ts`) and Ledger acquire `bleLock` before any scan/connect, release on teardown. Never `new BleManager()` in the Ledger path (rely on ble-plx's native singleton); never `.destroy()` from either consumer. IF, after installing the pinned package, its constructor/`open` is confirmed to accept an injected manager, promote injection as a defense-in-depth secondary â€” but ship on `bleLock` alone. Validate the RNÃ—ble-plxÃ—ledger triple on a real Nano X before further work.

**Signing/blind-sign:** identical footgun + ordering + `0x6808` handling as extension. Wrapped by `makeLedgerWalletSigner(): WalletSigner` â†’ plugs into the existing seam at `services/denominatedPool/index.ts:1457` `signAndSend` (already branches `walletSigner`). No service-layer signature change.

**Ordering (Finding #13, mobile):** unshield/transfer pre-fund an ephemeral submitter + route through the relayer (`signAndSendViaRelayer`). Proof + ix assembly + fresh blockhash MUST precede the device prompt. Transport not persisted across relaunch â†’ "Reconnect your Ledger" state before any signing op.

**ZK seed + backup:** CSPRNG â†’ SecureStore `p01_hw_spending_seed_<base58>` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, `secureSetWithRetry`). Fed RAW to the pipelines (Â§0). Backup v2 corrected per Finding #11 (below).

---

## 2. RISK REGISTER

Severity | Finding | Disposition
---|---|---
**CRITICAL** | #6 Specs route hardware seed through `deriveP01IdentityFromSeed` (HKDF), but live pipelines key off RAW `secretKey.slice(0,32)`. Pre-HKDF'ing yields a DIFFERENT 32 bytes â†’ unspendable notes. | **ACCEPT + FIX.** Â§0 decree: hardware seed fed RAW to the same consumers. `deriveP01IdentityFromSeed` is NOT used for notes. Gate with cross-subsystem parity test (S0-T1) BEFORE any Ledger code.
**CRITICAL** | #7 Flagship shielded/subscribe path (`zk.ts`/`shielded.ts getSeedPhrase`) needs `_keypair` + `SHA-256(hex(seed))`; hardware `_keypair===null` throws at `shielded.ts:447`. Omitted from all specs. | **ACCEPT + FIX.** Make `getSeedPhrase()` walletKind-aware: hardware â†’ `hex(getSpendingSeed())`, so the existing `SHA-256(hex+':spending_key')` runs over the RAW random seed (consistent with Â§0). Added to MODIFY list (E-step).
**HIGH** | #1 SAS omits QR#2; paste downgrades SAS to a tap â†’ MITM re-open. | **ACCEPT + FIX.** SAS hashes BOTH frames incl `ephX25519Pub`+`kemCiphertext` (Â§1A). Paste path FORCES typing the 6 digits + untrusted-channel warning.
**HIGH** | #3 Zeroization unenforceable on JS strings; clipboard/filmed-QR exposure. | **ACCEPT (honest downgrade).** Stop promising mnemonic zeroization; `fill(0)` only the byte buffers; forbid clipboard for raw phrase; `FLAG_SECURE`/screenshot-block on pairing screens.
**HIGH** | #8 â‰¥4 inline `_keypair`/`tx.sign(keypair)` builders, not 2: `signer.ts`, `denominatedPool.ts`, `subscriptionVault.ts:100`, `shielded.ts:444` (+ `store/stealth.ts`). subscriptionVault missing from spec â†’ subscribe-with-Ledger throws. | **ACCEPT + FIX.** Enumerate ALL; collapse to one `getActiveSigner()`/`getWalletSeed()` branching on walletKind; add grep gate for residual `_keypair.secretKey`. All four in MODIFY list.
**HIGH** | #9 crxjs won't emit an unreferenced `connect-ledger.html`; spec is self-contradictory. Verified: `vite.config.ts` has no `input`. | **ACCEPT + FIX.** Drop new HTML entry. Render `ConnectLedger` + `PairDevice` as hash routes in `popup.html`, opened in a tab via `chrome.tabs.create`. No manifest/vite change.
**HIGH** | #14 Extension store has no `walletKind`; partialize whitelist + `!!encryptedSeedPhrase` init gate break for seedless hardware. | **ACCEPT + FIX.** Extend `partialize` with `walletKind`/`ledgerPath`/`publicKey`; bump persist version (2â†’3) + migrate defaulting `'local-seed'`; change init gate to `walletKind==='hardware' ? !!ledgerPath&&!!publicKey : !!encryptedSeedPhrase`.
**MEDIUM** | #2 Hybrid HKDF omits eph pubkey+KEM ct cross-binding; no low-order X25519 check. | **ACCEPT + FIX.** Pairing box salt = `H(eph,x25519Pub,kemPub,kemCt,nonce)`; reject all-zero scalarMult on encrypt+decrypt. (Applies to pairing box only; note `noteCrypto.ts` left as-is â€” out of scope, flag as OPEN-Q #4.)
**MEDIUM** | #4 Replay on wall-clock; no used-nonce ledger; PBKDF2 100k not 600k (verified `crypto.ts:21,140,161`). | **ACCEPT + FIX.** Consumed-flag + used-nonce set; clock = UX only; bump `crypto.ts` PBKDF2 â†’ 600k (R-10) before pairing/Ledger ship.
**MEDIUM** | #5 Unauthenticated QR-chunking; forged-QR prefix-routing DoS; post-persist pubkey gate. | **ACCEPT + FIX.** Chunk ONLY ciphertext with `total-length + SHA-256 + sessionId`, verify before decrypt. Enforce exact prefix+version+length + max-input-length before base64-decode; dedicated pairing scanner (not the note scanner). Move pubkey-confirm BEFORE persist; fold sender pubkey into SAS.
**MEDIUM** | #11 Mobile backup KDF is nacl-SHA512-100k (verified `backup/index.ts:84`), NOT PBKDF2; payload is mnemonic-native, no hardware-seed shape. | **ACCEPT + FIX.** Backup v2: define hardware payload variant (`p01SpendingSeed`, no `mnemonic`); restore writes seed to SecureStore + sets walletKind WITHOUT `importWallet`. Decide KDF: keep SHA-512 but raise iterations to â‰¥600k-equivalent OR migrate to PBKDF2-600k; version the envelope; v1 read-compat. Round-trip test mandatory.
**MEDIUM** | #12 BleManager injection unverified (package uninstalled); legacy transport may make its own manager. | **ACCEPT (re-architected).** `bleLock` strict mutual exclusion is PRIMARY; injection is opportunistic secondary only if the installed API supports it. Validate on real Nano X first.
**MEDIUM** | #13 Specs never sequence proof-build vs device-sign; 2-min proof + blockhash expiry + popup/HID death compound. | **ACCEPT + FIX.** Explicit ordering: proof â†’ assemble ix â†’ fresh blockhash â†’ compileMessage â†’ device prompt. Offscreenâ†’tab handoff (ext); blockhash-staleness re-sign.
**MEDIUM** | #10 Extension has NO QR decoder (verified: only `qrcode.react` render). | **ACCEPT + FIX.** Extension posture = copy-paste-only (shows QR#1, pastes QR#2; phone does camera). If camera ever wanted on ext, add `jsQR`/`@zxing/browser` explicitly. Spec made internally consistent: no camera-scan claim on extension without a decoder dep.
**LOW** | #15 Pairing relies on cross-client ZK parity invariant without stating it. | **ACCEPT.** Documented invariant + parity test (shared with S0-T1).
**LOW** | #16 QR sizing "comfortable Version 27" optimistic for screen-to-camera. | **ACCEPT.** Copy-paste is the primary cross-device channel; dense single QR is best-effort. If camera used: ECC level L, larger render, or chunk. Test on a mid-range phone.
**LOW / CONFIRM** | #17 WebHID gating, blind-sign `0x6808`, no-signMessage-hardware, WalletSigner seam, RN 0.81.5/ble-plx perms â€” all verified CORRECT. | **NO ACTION.** Implement as written; do not re-litigate.

No findings rejected. All 17 are real.

---

## 3. ORDERED IMPLEMENTATION PLAN

Dependencies are strict top-to-bottom within a stage; stages gate each other.

### STAGE S0 â€” Canonical-seed parity (BLOCKS everything; no Ledger/pairing code before this is green)
- **S0-T1** ADD `packages/privacy-sdk/src/identity/seedParity.test.ts` (or co-locate): assert that a fixed 32-byte seed, fed via the SAME path a hardware seed will take, produces the SAME note commitment / zk address that the live local raw-slice path produces. Documents the canonical seed = RAW 32 bytes (NOT HKDF'd). Encodes the Â§0 + Finding #15 invariant. **Deps:** none. **Modifies:** none (test + a doc comment in `deriveIdentity.ts` marking `deriveP01IdentityFromSeed` as SDK-identity-API-only, not note-path).
- **S0-T2** MODIFY `apps/extension/src/shared/services/crypto.ts:21,140,161` â€” PBKDF2 100000 â†’ 600000 (R-10, Finding #4). **Deps:** none. (Shared hardening; benefits seed wallets too.)

### STAGE S1 â€” Shared SDK pairing helpers (single source of truth)
- **S1-T1** ADD `packages/privacy-sdk/src/pairing/box.ts` â€” hardened hybrid box: `generateEphemeralPairingKeys()`, `encryptToPairingBundle(bundle, payload)â†’p01pairenc1:`, `decryptWithEphemeral(keys, blob)`. Salt binds eph+static pubkeys+KEM ct+nonce; reject all-zero scalarMult (Finding #2). Domain `p01-pair-enc-hybrid-v1`. **Deps:** `tweetnacl`, `@noble/*`, `@noble/post-quantum` (present in SDK).
- **S1-T2** ADD `packages/privacy-sdk/src/pairing/protocol.ts` â€” `buildPairingQr1`/`parsePairingQr1` (prefix+version+exact-length+max-input checks, Finding #5), `encodePairingPayload`/`decodePairingPayload`, `computeSAS(receiverBundle, nonce, expiry, qr2EphPub, qr2KemCt)` (BOTH frames, Finding #1), chunk framing (`ciphertext-only + total-len + SHA-256 + sessionId`, verify-before-decrypt, Finding #5), consumed-nonce set helper (Finding #4), constants (`PAIRING_TTL_SECS=90`, prefixes, domain strings). **Deps:** S1-T1.
- **S1-T3** ADD `packages/privacy-sdk/src/pairing/index.ts` + export from `src/index.ts`. **Deps:** S1-T1,T2.
- **S1-T4** ADD `packages/privacy-sdk/src/pairing/protocol.test.ts` â€” round-trip; SAS-mismatch-on-tampered-QR1; SAS-mismatch-on-tampered-QR2 (the Finding #1 regression test); expired-TTL reject; nonce-mismatch reject; BIP39-checksum reject; low-order-point reject; chunk-splice reject; oversized-input reject. **Deps:** S1-T1,T2,T3.

### STAGE S2 â€” Pairing, extension (depends S1; copy-paste-only posture, Finding #10)
- **S2-T1** ADD `apps/extension/src/shared/services/pairing.ts` â€” adapter: `startAsReceiver()` (ephemeral keys in non-persisted ref), `senderConsumeQr1`, `senderBuildQr2` (reads active mnemonic by decrypting `encryptedSeedPhrase` with session password; NEVER logged), `receiverConsumeQr2`â†’`{mnemonic, walletKind}`. Guard: throw if active wallet not seed-backed. No-console-mnemonic review note.
- **S2-T2** ADD `apps/extension/src/popup/pages/PairDevice.tsx` â€” mode toggle; QR render (`qrcode.react`); copy-paste textareas (PRIMARY); FORCED 6-digit SAS entry on paste path (Finding #1); pubkey-confirm BEFORE import-persist (Finding #5); mirror `DenominatedImport.tsx` styling. Opened in a TAB via `chrome.tabs.create({url: 'popup.html#/pair-device'})` (Finding #9).
- **S2-T3** MODIFY `apps/extension/src/popup/App.tsx` â€” add `<Route path="/pair-device" .../>`.
- **S2-T4** MODIFY `apps/extension/src/popup/pages/Settings.tsx` â€” "Link another device" row â†’ opens tab.
- **S2-T5** ADD `apps/extension/src/shared/services/pairing.test.ts`.

### STAGE S3 â€” Pairing, mobile (depends S1; CAMERA path, sidesteps BLE entirely)
- **S3-T1** ADD `apps/mobile/services/pairing/pairing.ts` â€” adapter (same surface as S2-T1); sender reads `getMnemonic()`; receiver calls `importWallet(mnemonic)`; `fill(0)` byte buffers.
- **S3-T2** ADD `apps/mobile/app/(main)/(settings)/pair-device.tsx` â€” `expo-camera CameraView` + dedicated pairing scanner with exact-prefix/length gate (Finding #5; NOT the note scanner); `react-native-qrcode-svg` render; SAS card reusing `FingerprintVerification` look but FORCED cross-entry; `FLAG_SECURE` on screen (Finding #3).
- **S3-T3** MODIFY `apps/mobile/app/(auth)/import.tsx` and/or `app/(onboarding)/index.tsx` â€” "Pair with another device" â†’ RECEIVER flow.
- **S3-T4** MODIFY `apps/mobile/app/(main)/(settings)/index.tsx` â€” "Link another device" â†’ SENDER flow.
- **S3-T5** ADD `apps/mobile/services/pairing/pairing.test.ts`.

### STAGE S4 â€” Ledger extension (depends S0)
- **S4-T1** ADD deps to `apps/extension/package.json`: `@ledgerhq/hw-transport-webhid`, `-webusb`, `hw-app-solana`, `errors`. Pin + install.
- **S4-T2** ADD `src/shared/services/ledger/{path.ts, transport.ts, solanaApp.ts, signer.ts, spendingSeed.ts}` â€” transport (WebHID primary/WebUSB fallback, `isSupported`, long-lived on tab); solanaApp (`getAddress`, `signTransaction(compiledMsg)`, `getAppConfiguration`); signer (`WalletSigner` builder + `LedgerNoMessageSigningError` + `getSpendingSeed`); spendingSeed (CSPRNG, AES-GCM 600k, zeroize, fed RAW per Â§0).
- **S4-T3** ADD `src/shared/services/backup.ts` â€” `p01id1:` encrypted identity backup (hardware variant: `{p01SpendingSeed, walletKind:'hardware', ledgerPath, publicKey}`), export/restore.
- **S4-T4** MODIFY `src/shared/store/wallet.ts` â€” persisted `walletKind`/`ledgerPath` (Finding #14: extend `partialize`, bump version 2â†’3 + migrateâ†’`'local-seed'`, change init gate); allow `_keypair===null` for hardware; audit `getActiveKeypair`.
- **S4-T5** MODIFY the FOUR signer seams (Finding #8): `services/signer.ts` (`getActiveSigner`+`getWalletSeed`), `store/denominatedPool.ts:207` (collapse to import from signer.ts), `services/subscriptionVault.ts:100` (`createWalletSigner`), `store/stealth.ts` â€” all branch on `walletKind`. **+** MODIFY `store/shielded.ts:444` `getSeedPhrase()` â†’ hardware returns `hex(getSpendingSeed())` (Finding #7).
- **S4-T6** ADD `src/popup/pages/ConnectLedger.tsx` (hash route, opened in tab) + `src/popup/components/LedgerReviewModal.tsx` (blind-sign explainer + `0x6808`); MODIFY `App.tsx` route, `Settings.tsx`/`Welcome.tsx` entries.
- **S4-T7** Wire proofâ†’assembleâ†’fresh-blockhashâ†’device-sign ordering + offscreenâ†’tab handoff (Finding #13). Grep gate for residual `_keypair.secretKey`.

### STAGE S5 â€” Ledger mobile (depends S0; can run parallel to S4)
- **S5-T1** ADD deps `apps/mobile/package.json`: `@ledgerhq/react-native-hw-transport-ble`, `hw-app-solana`, `errors`. Install + **smoke-test the build + real Nano X on RN 0.81.5Ã—ble-plx 3.5.1** (Finding #12,17) BEFORE further work.
- **S5-T2** ADD `apps/mobile/services/ledger/bleLock.ts` â€” async mutex (PRIMARY coexistence, Finding #12).
- **S5-T3** MODIFY `apps/mobile/services/sharing/transport/ble.ts` â€” export `getSharedBleManager()`; wrap scan/connect entry points in `bleLock`.
- **S5-T4** ADD `apps/mobile/services/ledger/{transport.ts, solanaApp.ts, signer.ts, spendingSeed.ts}` â€” transport (`observeState`/`listen`/`open`/`close`, `bleLock`, no `.destroy()`); solanaApp (footgun); signer (`makeLedgerWalletSigner` + blind-sign gate + `LedgerNoMessageSigningError`); spendingSeed (SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, RAW per Â§0).
- **S5-T5** MODIFY `apps/mobile/services/solana/wallet.ts:336` â€” `getSpendingSeed()` hardware branch; **+** route `denominatedPoolStore.ts:833,882` (direct slice reads) through `getSpendingSeed()` for hardware (Finding #6).
- **S5-T6** MODIFY `apps/mobile/stores/walletStore.ts` â€” persist `walletKind`/`ledgerPath`/`publicKey` (R-02 lock); `connectLedger()`, `getActiveWalletSigner()`; non-persisted transport/signer; relaunch "reconnect" state.
- **S5-T7** MODIFY `apps/mobile/services/backup/index.ts` â€” backup v2 hardware variant + KDF decision (Finding #11), v1 read-compat, round-trip test.
- **S5-T8** ADD `apps/mobile/app/(main)/(settings)/connect-ledger.tsx` + `components/LedgerReviewSheet.tsx` (`0x6808`/`0x6985`/disconnect/timeout). Wire proofâ†’sign ordering (Finding #13). Verify `denominatedPoolStore`/`subscriptionVaultStore` + screens pass `getActiveWalletSigner()` for hardware.

---

## 4. UI WORK-UNITS (parallelizable)

UI-1 | Extension `PairDevice.tsx` â€” copy-paste-first, QR#1 render, forced SAS entry, pubkey-confirm-before-import. Mirror `DenominatedImport.tsx`. (deps: S2-T1)
UI-2 | Mobile `pair-device.tsx` â€” camera scanner + dedicated gate, QR render, forced-cross-entry SAS card, `FLAG_SECURE`. Reuse `scan.tsx`/`FingerprintVerification`. (deps: S3-T1)
UI-3 | Extension `ConnectLedger.tsx` (tab hash route) â€” connect â†’ confirm address â†’ blind-sign enable â†’ backup prompt. (deps: S4-T2,T3)
UI-4 | Extension `LedgerReviewModal.tsx` â€” per-sign review + blind-sign gate + `0x6808` copy. (deps: S4-T2)
UI-5 | Mobile `connect-ledger.tsx` â€” bluetooth-offâ†’scanâ†’bondâ†’confirm-addressâ†’enable-blind-signâ†’connected + backup prompt + reconnect state. (deps: S5-T4,T6)
UI-6 | Mobile `LedgerReviewSheet.tsx` â€” per-sign sheet, `0x6808`/`0x6985`/disconnect/timeout. (deps: S5-T4)
UI-7 | Settings/Welcome entry rows (ext `Settings.tsx`/`Welcome.tsx`; mobile settings index + import/onboarding) â€” "Link another device" + "Connect Ledger". (deps: routes exist)

UI-1/UI-2 are independent of UI-3..6; all seven can proceed once their adapter dep lands. UI-3/4 (ext Ledger) and UI-5/6 (mobile Ledger) are fully independent of each other.

---

## 5. OPEN QUESTIONS (need the human)

1. **Backup KDF decision (Finding #11):** mobile backup is currently nacl-SHA512Ã—100k (NOT PBKDF2). For v2, migrate to PBKDF2-600k (re-encrypt all existing backups on next open) OR keep SHA-512 and raise iterations to a 600k-equivalent cost? The former matches the extension's PBKDF2-600k for cross-platform consistency but breaks v1 byte-format; the latter is less churn. Which?
2. **Pairing direction support:** confirm we need BIDIRECTIONAL extensionâ‡„mobile, or is the realistic flow always "mobile is the source of truth, extension imports"? If one-directional, the extension never needs a camera at all and UI-1 simplifies to receiver-shows / sender-pastes only.
3. **Mobile `react-native-ble-plx` BleManager injection (Finding #12):** are you OK shipping `bleLock` strict-mutual-exclusion as the PRIMARY guarantee (note-sharing and Ledger never scan concurrently), accepting that the user cannot run a Ledger sign and a BLE note-share at the literal same instant? Confirmed safe and simplest, but it's a real UX constraint to sign off on.
4. **`noteCrypto.ts` hardening backport:** the pairing box fixes the cross-binding + low-order gap (Finding #2). Should we ALSO backport those fixes into the live `noteCrypto.ts` used for value-bearing denominated notes (currently has the same gaps), or leave that as a separate scoped task? Backporting changes the denominated-note wire format â†’ migration concern.
5. **Mobile `sentinel.ts` (spec Â§1.8):** ship the experimental sentinel or drop it? Recommendation: DROP for this phase (not load-bearing).
6. **Ledger BIP44 path policy:** fix `44'/501'/0'/0'` for v1, or expose an account-index chooser at connect time? Affects whether backup must store `ledgerPath` as variable (it should regardless).

---

### Key grounding files (all absolute, verified)
- `D:\Protocol-01\apps\extension\src\shared\services\noteCrypto.ts` (liftâ†’SDK pairing box; lines 71-89 keygen/address, 128-177 encrypt/decrypt)
- `D:\Protocol-01\apps\extension\src\shared\services\signer.ts` (seams: `getActiveSigner`:20, `getWalletSeed`:53)
- `D:\Protocol-01\apps\extension\src\shared\store\denominatedPool.ts` (inline signer:187, `getWalletSeed`:207)
- `D:\Protocol-01\apps\extension\src\shared\services\subscriptionVault.ts` (4th signer `createWalletSigner`:100 â€” was missing from spec)
- `D:\Protocol-01\apps\extension\src\shared\store\shielded.ts` (`getSeedPhrase`:444, throws for hardware:447) + `zk.ts` `deriveSpendingKey`:216 (`SHA-256(hex+':spending_key')`)
- `D:\Protocol-01\apps\extension\src\shared\store\wallet.ts` (partialize:583 â€” no walletKind)
- `D:\Protocol-01\apps\extension\src\shared\services\crypto.ts` (PBKDF2 100000 at :21,:140,:161 â†’ 600000)
- `D:\Protocol-01\apps\extension\vite.config.ts` (crxjs `crx({manifest})`:37, rollupOptions no `input`:72 â†’ confirms #9)
- `D:\Protocol-01\packages\privacy-sdk\src\identity\deriveIdentity.ts` (`deriveP01IdentityFromSeed`:88 = HKDF, dead-code for notes)
- `D:\Protocol-01\apps\mobile\services\solana\wallet.ts` (`deriveLocalNoteSeed`:314 raw slice, `getSpendingSeed`:336 TODO)
- `D:\Protocol-01\apps\mobile\stores\denominatedPoolStore.ts` (direct raw slice:833,882 â€” must route through getSpendingSeed)
- `D:\Protocol-01\apps\mobile\services\backup\index.ts` (KDF nacl-SHA512Ã—100k:84 â€” NOT PBKDF2; mnemonic-native)
- `D:\Protocol-01\apps\mobile\services\sharing\transport\ble.ts` (singleton `getManager` to promote + `bleLock`-wrap)

Verified package state: extension has `qrcode.react@^4.2.0` (render-only, NO decoder), `@noble/post-quantum@^0.6.1`, `tweetnacl@^1.0.3`; NO `@ledgerhq/*`. Mobile is `react-native@0.81.5`, `react-native-ble-plx@^3.5.1`, `react-native-get-random-values@~2.0.0`, `expo-camera@~17.0.10`, `react-native-qrcode-svg@^6.3.21`; NO `@ledgerhq/*`.
