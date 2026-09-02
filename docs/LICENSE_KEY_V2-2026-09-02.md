# License key derivation v2: the issuer cannot compute the key

Status: specified 2026-09-02, wired on the web client the same day, additive in
the three mirrors (mobile, extension, merchant SDK).

## Why

A `P01-…` key is `encodeLicenseKey(licenseSecret)` and the vault stores
`license_commitment = blake3(licenseSecret)`. Under v1,

```
licenseSecret = HKDF-SHA256(ikm = utf8(noteSecret.toString(10)),
                            salt = none,
                            info = utf8("p01-license-v1") || utf8(serviceTag),
                            16 bytes)
```

The only secret in that derivation is the note secret. For a note the buyer
shielded themselves that is exclusive to them. For a note the treasury ISSUED
(the exchange: pay the till, collect an older note), the treasury recomputes the
note secret from its seed at any time (`apps/web/app/api/issue-note/route.ts`,
`deriveNoteMaterial(seed, pool, leafIndex)`), and the service tag is a public
registry slug. So the operator could compute the exact key of every customer
who paid through the exchange and present it at the merchant. That was the
open limit D8, measured live on 2026-09-02 (record
`packages/merchant-sdk/records/live-license-issued-note-2026-09-02.json`: the
key is valid at the merchant, and it was derivable by us).

## The v2 derivation

Mix in a secret the treasury never sees and the buyer can always regenerate:
the buyer's pool identity seed. That seed is `HKDF(wallet signature over the
derivation message)`; it exists only in the buyer's worker, it is what already
recovers the buyer's notes on any device, and the treasury never receives the
signature.

```
licenseSalt   = HKDF-SHA256(ikm = identitySeed (32 bytes),
                            salt = none,
                            info = utf8("p01-license-salt-v2"),
                            32 bytes)

licenseSecret = HKDF-SHA256(ikm = utf8(noteSecret.toString(10)) || licenseSalt,
                            salt = none,
                            info = utf8("p01-license-v2") || utf8(serviceTag),
                            16 bytes)

key           = "P01-" + Crockford-base32(licenseSecret), grouped in 4s   (unchanged)
commitment    = blake3(licenseSecret)                                     (unchanged)
```

`identitySeed` is the active pool seed of the identity the note is filed under
(the same seed that decrypts the note blob), including the passphrase-salted
variant when one is set. Nothing on the wire changes: the vault still stores 32
commitment bytes, circuit 7 still binds them into its digest, the merchant SDK
still checks `blake3(key) == license_commitment` and never derives anything.

## Test vector (all mirrors pin it)

```
identitySeed   0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
noteSecret     "1234"
serviceTag     "svc"
licenseSalt    058f3c959dba16c347e5e291f65e6d7a26824f1006e541d0b4aba79004c90e6a
licenseSecret  de00e41667d82798b62825793d51be69
key            P01-VR0E-85K7-V0KS-HDH8-4NWK-TMDY-D4
commitment     852e98e702bc79617d20199cf25753264b0da206e2835e476caf4b4e865b8fac
```

Computed with `@noble/hashes` (hkdf, sha256, blake3) on 2026-09-02; the v1
vector (`P01-000G-40R4-0M30-E209-185G-R38E-1W` from the 000102…0f secret)
stays as it is.

## What changes, per surface

- **Web client (wired).** New subscriptions derive with v2. The local record
  stores `licenseScheme: 'v2'`. Every re-derivation (the Reveal button, the
  recovery scan, the tag matcher added the same day in
  `apps/web/lib/privacy/licenseTagMatch.ts`) tries v2 then v1 for each
  candidate tag and keeps the one whose blake3 equals the on-chain commitment,
  so vaults opened before this change still show their key.
- **Mobile, extension (additive).** `deriveLicenseSecretV2` and the vector are
  added next to v1 so the mirrors stay byte-matched; they keep minting v1 for
  their own self-shielded notes until they carry an identity seed of the same
  shape. Their notes are not treasury-issued, so D8 does not apply to them.
- **Merchant SDK (additive).** `deriveLicenseSecretV2` exists for tests and
  tooling only; verification is unchanged and needs no version: a v1 key and a
  v2 key are both 16 bytes whose blake3 the vault carries.

## What v2 does and does not change

- The treasury can no longer compute a key from its seed: it lacks the buyer's
  identity seed. The custody limit on issued notes stays (the issuer can still
  spend an issued note before the holder does; that is a note problem, not a
  key problem).
- The key is still bearer material: whoever holds it is the customer.
- Recoverability is unchanged in practice: the key was already only
  re-derivable by someone holding the note, and an issued note lives only in
  the identity's store, which needs the same wallet signature.
- Keys minted under v1 stay valid; the merchant cannot and need not tell them
  apart.
