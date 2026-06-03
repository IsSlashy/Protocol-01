I have everything needed, including the critical `permissions-policy` "hid" gotcha for iframes/extension pages. Synthesizing the final findings.

---

# De-Risking Research: Ledger Hardware + Device-to-Device Pairing

Grounded against the existing repo (`noteCrypto.ts` hybrid PQ box, the `privacy-sdk` UnifiedSigner model, and `docs/privy-removal-spec.md` Â§1.7 / Phase 4). Both features are constrained by one hard fact already documented in the spec: **privacy ops (shield/unshield/transfer) need the spending key in cleartext locally as a STARK witness.** Ledger can never produce or hold that key, so for P01 the Ledger is strictly an *on-chain tx co-signer*, never the source of the ZK spending key. The pairing feature is what actually moves the spending seed between devices. Findings below assume that division of labor.

---

## A) LEDGER HARDWARE (2026)

### A.1 Chrome extension â€” transport + signing

**Can a browser extension use WebHID? Yes, but `requestDevice()` is gated to a visible extension page.**
- WebHID needs **no manifest permission and no manifest key** â€” it is gated entirely by a runtime user-permission prompt that requires a user gesture ([Chrome WebHID guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/webhid)).
- `navigator.hid.requestDevice()` **cannot be called from the MV3 service worker** (no user gesture, no DOM). It must be called from the **popup or a full extension page** (e.g. a `chrome-extension://â€¦/connect-ledger.html` tab). After the user picks the device once, the SW can later reach it via `navigator.hid.getDevices()` (the grant persists) ([Chrome WebHID guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/webhid), [Intent to Prototype](https://groups.google.com/a/chromium.org/g/blink-dev/c/U1B81QRAQ34)).
- **The offscreen document is NOT a viable place to run the device picker.** The offscreen Reason enum has no WebHID/HID reason ([Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)), and more fundamentally the offscreen doc is non-interactive (no user gesture), so `requestDevice()` would reject there regardless. Offscreen is the wrong tool for Ledger; it's the right tool for your *ZK job* runner (already in the plan).
- **Permissions-Policy gotcha:** `getDevices()`/`requestDevice()` throw `"Access to the feature 'hid' is disallowed by permissions policy"` when called from an iframe/embedded context without `allow="hid"`. This bit MetaMask's extension ([MetaMask #12257](https://github.com/MetaMask/metamask-extension/issues/12257)). Run Ledger code from a **top-level extension page, not an embedded iframe.**

**Recommended extension architecture:**
- A dedicated **connect page** (a real tab `popup/pages/ConnectLedger.tsx` opened via `chrome.tabs.create`, NOT the ephemeral toolbar popup) calls `TransportWebHID.create()` after a button click. This matches your own MEMORY note "WebHID primary, WebUSB fallback â€” popup/connect-tab, NEVER service worker." Prefer the **tab over the toolbar popup**, because the popup dies on focus loss (the exact bug that forced your ZK-offscreen refactor) and would tear down the HID session mid-signing.
- Transport: `@ledgerhq/hw-transport-webhid` primary, `@ledgerhq/hw-transport-webusb` fallback. Both expose the identical `create()` flow; the Ledger docs note the two integrations differ by "only a few lines" ([Ledger Web USB/HID](https://developers.ledger.com/docs/device-interaction/ledgerjs/integration/web-application/web-hid-usb)). Also add `@ledgerhq/hw-app-solana`, `@ledgerhq/errors`, `@ledgerhq/logs`.
- App layer: `new Solana(transport)` â†’ `getAddress("44'/501'/0'")` for pubkey, `signTransaction(path, messageBytes)` for signing, `getAppConfiguration()` to read `blindSigningEnabled` ([Ledger Solana signer](https://developers.ledger.com/docs/device-interaction/references/signers/solana)).

**Known gotchas (extension):**
- WebHID flicker / connect-disconnect loops have been reported in Chromium-based browsers ([Brave #19480](https://github.com/brave/brave-browser/issues/19480)); keep the transport on one long-lived page, don't create/destroy per call.
- `TransportWebHID` has had silent `create()` failures on newer devices (Stax/Flex) on `hw-transport-webhid@6.29.2` ([ledger-live #7611](https://github.com/LedgerHQ/ledger-live/issues/7611)) â€” pin a current version and test on the actual target device.
- WebHID is Chromium-only (Chrome/Edge/Brave/Opera). **No Firefox, no Safari.** Acceptable for a Chrome extension; just gate the UI with a capability check.

### A.2 The signing-API footgun (applies to BOTH platforms)

`hw-app-solana.signTransaction(path, buffer)` expects the **serialized message bytes**, *not* a full `Transaction` with empty signature slots. The correct flow is: `tx.compileMessage()` â†’ serialize the *message* â†’ `signTransaction` â†’ take the returned 64-byte signature â†’ `tx.addSignature(pubkey, sig)` ([Solana message structure](https://solana.com/docs/core/transactions/transaction-structure), [npm hw-app-solana usage](https://www.npmjs.com/package/@ledgerhq/hw-app-solana)). Passing a fully serialized transaction (with the signatures array prepended) is the classic mistake and produces an invalid signature. For v0 / versioned txs use `message.serialize()` from `VersionedTransaction`. This is identical on extension and mobile.

### A.3 Blind-signing requirement (the P01-specific blocker)

P01 pool instructions are custom-program ix; the Ledger Solana app only clear-signs simple System/SPL transfers and a few combos. **Anything else returns `0x6808` (BLIND_SIGNATURE_REQUIRED), and the device refuses unless "Allow blind sign" is enabled** in the on-device Solana app settings ([Ledger blind-sign article](https://support.ledger.com/article/4499092909085-zd), [app-solana repo](https://github.com/LedgerHQ/app-solana)). So every P01 shield/unshield/subscribe co-signed by a Ledger will hit `0x6808` on a fresh device.

**Implementation requirement:** before signing a pool tx, call `getAppConfiguration()` and read `blindSigningEnabled`; if false, show a one-time explainer gating the action ("Open the Solana app â†’ Settings â†’ enable Allow blind sign"). Catch `0x6808` from `@ledgerhq/errors` as the fallback path. Note Ledger is broadly tightening clear-signing policy in 2025â€“2026, but custom programs without a dedicated plugin will still require blind-sign for the foreseeable future.

### A.4 React Native (mobile) â€” BLE transport

- Package: `@ledgerhq/react-native-hw-transport-ble` (Nano X only â€” S/S Plus have no BLE). API is observable-based: `TransportBLE.observeState` (Bluetooth availability) â†’ `TransportBLE.listen` (Observable emitting `{type:'add', descriptor}`) â†’ `TransportBLE.open(descriptor)` â†’ `new Solana(transport)` ([Ledger RN BLE iOS](https://developers.ledger.com/docs/device-interaction/ledgerjs/integration/mobile-application/react-native-bluetooth-ios), [Android](https://developers.ledger.com/docs/device-interaction/ledgerjs/integration/mobile-application/react-native-bluetooth-android)).
- iOS native config: `NSBluetoothAlwaysUsageDescription` in Info.plist. Android: BLE + (API 31+) `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` runtime permissions; the Ledger docs also note Android needs a recent JavaScriptCore (`jsc-android`).
- Pairing UX: scanning surfaces nearby Nano X; the OS BLE bond prompt appears on first `open`. **There is no programmatic unpair** â€” if the bond breaks you must deep-link the user to system Bluetooth settings to "Forget" the device ([Ledger RN BLE docs](https://developers.ledger.com/docs/device-interaction/ledgerjs/integration/mobile-application/react-native-bluetooth-android)).

**The real conflict (load-bearing for P01): `react-native-ble-plx` BleManager.**
- `@ledgerhq/react-native-hw-transport-ble` is built **on top of `react-native-ble-plx`**, the same library the app already uses for note-sharing.
- **As of `react-native-ble-plx` 3.4.0, BleManager is a singleton â€” only one instance exists per app lifetime** ([ble-plx singleton, snyk/docs](https://snyk.io/advisor/npm-package/react-native-ble-plx/functions/react-native-ble-plx.BleManager), [GETTING_STARTED](https://github.com/dotintent/react-native-ble-plx/blob/master/docs/GETTING_STARTED.md)). On 3.4.0+ this means the Ledger transport and your note-sharing code **share one underlying manager**, which is good (no double-init crash) but means they must coordinate: don't call `manager.destroy()` from the note-sharing path while a Ledger session is open, and vice-versa. Run device scans **mutually exclusively** (your MEMORY already says "mutually-exclusive with note-sharing BleManager" â€” that's correct and now confirmed at the library level).
- On `react-native-ble-plx` **< 3.4.0**, two separate `new BleManager()` instances cause resource conflicts; if you're below 3.4.0, upgrade or funnel both consumers through a single shared instance.
- **Version-compatibility landmine:** `react-native-ble-plx` BLE-transport APIs **crash on RN 0.81.4** (Expo 54's recommended RN) while working on 0.79.6 ([ble-plx #1310](https://github.com/dotintent/react-native-ble-plx/issues/1310)). Given your `pnpm-10-monorepo-build-broken` note, pin and smoke-test the RNÃ—ble-plxÃ—ledger-transport triple before committing.
- **Deprecation watch:** Ledger is migrating off the legacy `react-native-hw-transport-ble` toward the Device Management Kit (DMK) BLE transport in Ledger Live ([LIVE-25036 PR #13859](https://github.com/LedgerHQ/ledger-live/pull/13859)). The legacy package still works and is fine to ship now, but treat it as "stable-but-sunsetting" and isolate it behind your own `services/ledger/transport.ts` seam so a DMK swap is localized.

### A.5 Cross-cutting Ledger gotcha: NO off-chain message signing

Don't plan any P01 flow that needs the Ledger to `signMessage` (off-chain). The Solana app's off-chain message signing is unreliable/blocked through wallets and version-gated, and your spec already locked **`Signer{kind:'hardware'}` MUST NOT expose `signMessage`** (throw `LedgerNoMessageSigningError`). This is also *why* the ZK spending seed must come from the pairing feature, not the Ledger.

### A.6 Ledger recommendation (per platform)

- **Extension:** `@ledgerhq/hw-transport-webhid` (primary) + `-webusb` (fallback), `hw-app-solana`, `@ledgerhq/errors`. Run the picker and the transport on a **dedicated full extension tab** (not the toolbar popup, not the SW, not an offscreen doc, not an iframe). Sign the **compiled message bytes**, `addSignature`. Pre-flight `getAppConfiguration().blindSigningEnabled` and gate with a blind-sign explainer; catch `0x6808`.
- **Mobile:** `@ledgerhq/react-native-hw-transport-ble` (Nano X / BLE), `hw-app-solana`. Pin `react-native-ble-plx â‰¥ 3.4.0` and **share the single BleManager singleton** with the note-sharing path, scanning mutually-exclusively. Validate the RN version compatibility first. Same message-signing + blind-sign rules.
- **Both:** Ledger co-signs on-chain txs only. The ZK spending seed is a **CSPRNG random seed encrypted at rest** (spec Â§1.2) and its only portability/recovery path is the encrypted P01-identity backup (Â§1.7) â€” which is exactly Feature B.

---

## B) SECURE DEVICE-TO-DEVICE PAIRING (transfer a seed/secret via QR)

Goal: move the 32-byte spending seed (or the full encrypted P01-identity backup) from one device the user owns to another, over a QR channel, defeating MITM and replay.

### B.1 Threat model & the core defense (SAS)

The attack you must defeat is a MITM substituting their own ephemeral public key during the key exchange. The standard, well-studied defense is a **Short Authentication String (SAS)**: after both sides run an (unauthenticated) ephemeral DH, each derives a short value `SAS = truncate(H(transcript))` and the **user compares them out-of-band**. If a MITM injected a different key, the two SAS values differ and the user aborts ([Vaudenay SAS, Springer](https://link.springer.com/chapter/10.1007/11535218_19); [W3C STRINT MITM-on-ephemeral-DH](https://www.w3.org/2014/strint/papers/51.pdf)). Signal's "safety number" (60 digits, 12 groups of 5) and WebRTC SAS designs are the production references ([DEV: WebRTC ECDH+DTLS+SAS](https://dev.to/securebitchat/building-a-secure-webrtc-p2p-network-with-advanced-ecdh-dtls-and-sas-verification-27p7); [fingerprint length study, arXiv 2306.04574](https://arxiv.org/html/2306.04574)).

**Crucial simplification for your case:** the two devices are **co-present and owned by the same person**, and one channel (the QR) is already a high-bandwidth visual out-of-band channel. That lets you collapse SAS verification into the QR itself rather than asking the user to read digits aloud â€” *if* you bind the responder's key into a commitment shown before the secret is sent (below). A numeric SAS is still the right fallback when only one device can scan.

### B.2 Recommended handshake (commit-before-reveal, MITM- and replay-safe)

Reuse the existing `noteCrypto.ts` hybrid PQ box verbatim as the transport â€” it already does X25519 + ML-KEM-768 â†’ HKDF â†’ XSalsa20-Poly1305 and is deterministic-from-seed. Wrap it in a two-QR ceremony:

- **Roles:** the **new/empty device is the RECEIVER** (it will hold the secret afterwards); the **device that already has the seed is the SENDER**.
- **QR #1 â€” Receiver shows, Sender scans (the receive address):** Receiver generates a **fresh ephemeral** hybrid keypair *for this pairing only* (do NOT reuse the wallet-seed-derived `p01pq:` keys â€” you want forward secrecy and the receiver is empty anyway). It encodes `x25519Pub(32) â€– kemPub(1184)` exactly like `createNoteEncryptionAddress` produces, plus a random 16-byte `pairingNonce` and a short-lived `expiry`. Total â‰ˆ 1.25 KB â†’ one QR (see sizing).
- **SAS confirmation:** Both devices independently compute `SAS = base10(H("p01-pair-v1" â€– receiverPubBundle â€– pairingNonce))[:6 digits]` and display it. Because the sender scanned the receiver's actual key bundle off-band (the camera = authenticated channel), a MITM cannot have substituted keys without changing the SAS. The user taps "the codes match" on both. (When two-way scanning is possible, you can skip the read-aloud and show the SAS only as a tamper check.)
- **QR #2 â€” Sender shows, Receiver scans (the encrypted payload):** Sender calls `encryptNote(receiverAddress, payload)` where `payload = seed/identity-backup â€– pairingNonce â€– timestamp`. Output is your `p01enc1:` blob (`ephX25519Pub(32) â€– kemCiphertext(1088) â€– nonce(24) â€– ct`). Receiver scans, `decryptNote(ephemeralSeed, blob)`, and **verifies the embedded `pairingNonce` matches QR #1** â†’ replay/cross-session protection. Reject on mismatch or past `expiry`.
- **Forward secrecy & one-shot:** receiver discards the ephemeral pairing keypair after success; the QRs are useless afterwards (bound to a nonce + expiry that won't be accepted twice).

**Why this defeats MITM without read-aloud in the two-scan case:** the secret is encrypted to a key the sender obtained *by physically scanning the receiver's screen*. There is no network leg for an attacker to sit on. The SAS / nonce-echo is the defense-in-depth for the one-way-scan UX and for shoulder-surf/replay. This is the same "commit then reveal over an OOB visual channel" structure as the secure-pairing patents/literature ([USPTO 10,034,171 QR challenge-response](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10034171); [Vaudenay SAS](https://link.springer.com/chapter/10.1007/11535218_19)).

### B.3 What is encrypted vs. plaintext

- **Plaintext in QR #1:** receiver's *public* hybrid key bundle + nonce + expiry. Public keys are safe to expose (same reasoning as `p01pq:` addresses).
- **Encrypted in QR #2:** the seed/backup, under XSalsa20-Poly1305 with a key from the hybrid X25519+ML-KEM-768 agreement â€” **quantum-safe** (harvest-now-decrypt-later resistant), already implemented. A passively-filmed QR #2 is just ciphertext.
- Never put the raw seed, or anything derived directly from it, into a QR in cleartext â€” that's the exact bearer-note class bug already logged in MEMORY.

### B.4 QR sizing (this matters â€” the payload is large)

QR Version 40 byte-mode holds **2,953 bytes** max; alphanumeric **4,296 chars** ([DENSO Wave](https://www.qrcode.com/en/about/version.html); [qrcodechimp](https://www.qrcodechimp.com/qr-code-storage-capacity-guide/)). Your payloads:
- **QR #1 (receiver bundle):** `32 + 1184 = 1216` raw bytes; base64 â‰ˆ **1,621 chars** + prefix. Fits one QR at ~V25â€“28. Comfortable.
- **QR #2 (`p01enc1:` blob):** `32 + 1088 + 24 + ct`. For a 32-byte seed, `ct â‰ˆ 48` bytes â†’ raw â‰ˆ 1,192 bytes â†’ base64 â‰ˆ **1,590 chars**. One QR. For the **full encrypted identity-backup** (multiple keys + metadata) you may exceed 2,953 base64-bytes â†’ then **chunk**.

**Practical scanning ceiling, not theoretical:** dense QRs scan poorly. Open-source decoders (ZXing) drop to ~5% success on **Version 20+** codes, and small/dense codes fail materially more often ([qrcodechimp capacity guide](https://www.qrcodechimp.com/qr-code-storage-capacity-guide/), [the-qrcode-generator](https://www.the-qrcode-generator.com/blog/qr-code-data-size)). **Recommendation: cap each QR at ~Version 15â€“20 (â‰ˆ 800â€“1,200 bytes byte-mode at ECC level M) and chunk** anything larger. Use a simple framed chunk header `p01pair/<seq>/<total>/<sessionId>` (animated/rotating QR or "next" button) and reassemble. Prefer **base64 over a binary blob in byte-mode** for camera robustness and copy-paste fallback; or feed bytes straight into byte-mode if you keep chunks small. Always offer a **copy-paste text fallback** of the same `p01enc1:` blob (you already do this for notes) â€” large multi-frame QR scanning is the flakiest part of the UX.

### B.5 Pairing recommendation (safest practical handshake)

1. **Receiver (empty/new device) displays QR #1** = fresh ephemeral hybrid pubkey bundle + `pairingNonce` + `expiry`. Sender scans it.
2. **Both show a 6-digit SAS** = truncated hash over `(receiver bundle â€– pairingNonce)`; user confirms equality (tamper + replay check; in two-way-scan mode it's a confirmation tap, not read-aloud).
3. **Sender displays QR #2** = `encryptNote(receiverBundle, seed â€– pairingNonce â€– timestamp)` (your existing hybrid PQ `p01enc1:` blob, **chunked** if > ~1 KB). Receiver scans, decrypts, **verifies nonce + expiry**, persists to encrypted store (AES-GCM PBKDF2â‰¥600k / SecureStore), zeroizes buffers.
4. **One-shot:** ephemeral keys discarded; nonce/expiry prevent reuse. Provide copy-paste fallback for both frames.

This reuses 100% of `noteCrypto.ts`, is quantum-safe, needs no network, defeats MITM via the scanned-key + SAS binding, and defeats replay via the nonce+expiry echo. It's also exactly the recovery/portability mechanism the Ledger feature depends on (move the CSPRNG spending seed to a second device), so A and B share one crypto core.

---

### Key files to ground the implementation (all absolute)
- `D:\Protocol-01\apps\extension\src\shared\services\noteCrypto.ts` â€” REUSE as the pairing transport (hybrid PQ box; `encryptNote`/`decryptNote`/`createNoteEncryptionAddress`). For pairing, feed it a **fresh ephemeral seed**, not the wallet seed, for forward secrecy.
- `D:\Protocol-01\docs\privy-removal-spec.md` â€” Â§1.2 (hardware = CSPRNG seed, never signature-derived), Â§1.7 (encrypted P01-identity backup = the pairing payload), Phase 4 (Ledger packages already enumerated: extension `hw-transport-webhid/-webusb/hw-app-solana/errors`; mobile `react-native-hw-transport-ble/hw-app-solana/errors`), and the locked **`Signer{kind:'hardware'}` has no `signMessage`**.
- New seams to add per spec: extension `shared/services/ledger/{transport,solanaApp,signer,path}.ts` + a full-tab `ConnectLedger` page; mobile `services/ledger/{transport,solanaApp,signer,spendingSeed}.ts`.

### Open risks to flag to the caller
1. **Mobile BleManager coexistence** â€” confirm `react-native-ble-plx â‰¥ 3.4.0` (singleton) and that note-sharing + Ledger never scan concurrently; validate against the current RN version (ble-plx crashes on RN 0.81.4).
2. **Blind-sign UX** â€” every P01 pool tx will require on-device "Allow blind sign"; build the explainer + `0x6808` handling, or hardware users hit a hard wall on first shield.
3. **Extension transport lifetime** â€” run Ledger on a dedicated tab, not the toolbar popup (same focus-loss death as the ZK-offscreen bug).
4. **QR chunking** â€” single QR is fine for a 32-byte seed; the full identity-backup will exceed comfortable scan density and must be chunked + copy-paste-fallbacked.

Sources: [Chrome WebHID in extensions](https://developer.chrome.com/docs/extensions/how-to/web-platform/webhid) Â· [Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) Â· [WebHID in SW intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/U1B81QRAQ34) Â· [MetaMask hid permissions-policy](https://github.com/MetaMask/metamask-extension/issues/12257) Â· [Ledger Web USB/HID](https://developers.ledger.com/docs/device-interaction/ledgerjs/integration/web-application/web-hid-usb) Â· [Ledger Solana signer](https://developers.ledger.com/docs/device-interaction/references/signers/solana) Â· [hw-app-solana npm](https://www.npmjs.com/package/@ledgerhq/hw-app-solana) Â· [Ledger blind-sign](https://support.ledger.com/article/4499092909085-zd) Â· [app-solana repo](https://github.com/LedgerHQ/app-solana) Â· [Ledger RN BLE iOS](https://developers.ledger.com/docs/device-interaction/ledgerjs/integration/mobile-application/react-native-bluetooth-ios) Â· [Ledger RN BLE Android](https://developers.ledger.com/docs/device-interaction/ledgerjs/integration/mobile-application/react-native-bluetooth-android) Â· [ble-plx singleton](https://snyk.io/advisor/npm-package/react-native-ble-plx/functions/react-native-ble-plx.BleManager) Â· [ble-plx RN 0.81.4 crash](https://github.com/dotintent/react-native-ble-plx/issues/1310) Â· [Ledger DMK migration PR](https://github.com/LedgerHQ/ledger-live/pull/13859) Â· [Solana tx structure](https://solana.com/docs/core/transactions/transaction-structure) Â· [Vaudenay SAS](https://link.springer.com/chapter/10.1007/11535218_19) Â· [W3C STRINT MITM](https://www.w3.org/2014/strint/papers/51.pdf) Â· [WebRTC ECDH+SAS](https://dev.to/securebitchat/building-a-secure-webrtc-p2p-network-with-advanced-ecdh-dtls-and-sas-verification-27p7) Â· [fingerprint length study](https://arxiv.org/html/2306.04574) Â· [USPTO QR secure-pairing](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10034171) Â· [DENSO QR versions](https://www.qrcode.com/en/about/version.html) Â· [QR capacity guide](https://www.qrcodechimp.com/qr-code-storage-capacity-guide/) Â· [QR data size](https://www.the-qrcode-generator.com/blog/qr-code-data-size)
