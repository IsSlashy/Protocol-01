import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

/**
 * ABI regression gate for the subscription vault.
 *
 * WHY THIS FILE EXISTS. `subscribe_normal` was removed because its vault PDA
 * was seeded with the subscriber's wallet pubkey, which turned the vault
 * address into a membership oracle: re-derive
 * `PDA(["subscription_vault", retailer, wallet, mint])` and you learn whether
 * that wallet pays that merchant, for free and with no enumeration. The removal
 * shipped with ZERO automated coverage — `cargo test -p zk_shielded` runs one
 * test (`test_id`), and the only TypeScript suite that ever built the
 * instruction was deleted along with it. Nothing anywhere would have gone red
 * if the instruction came back.
 *
 * These assertions read the CHECKED-IN IDL, which `anchor idl build`
 * regenerates from the program source, so re-adding the instruction puts it
 * back and fails this file.
 *
 * WHAT THIS FILE DOES NOT COVER, stated so nobody reads it as more than it is:
 * a client can still hand `subscribe_private_stark` a `subscriber_commitment`
 * equal to a wallet pubkey and rebuild the identical oracle on the surviving
 * path — the program uses that argument only as a PDA seed and never binds it
 * to a proof. That is a client-side property and no assertion here touches it.
 */

const IDL_URL = new URL('../../../target/idl/zk_shielded.json', import.meta.url);

interface IdlField { name: string }
interface IdlType { name: string; type: { fields?: IdlField[] } }
interface Idl {
  instructions: { name: string; discriminator: number[] }[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string }[];
  types: IdlType[];
}

const idl: Idl = JSON.parse(readFileSync(IDL_URL, 'utf8'));

/** Anchor's discriminator: first 8 bytes of sha256 over a namespaced name. */
function anchorDiscriminator(namespaced: string): number[] {
  return Array.from(sha256(new TextEncoder().encode(namespaced)).slice(0, 8));
}

describe('published ABI carries no wallet-keyed way to open a subscription', () => {
  it('declares no subscribe_normal instruction', () => {
    const names = idl.instructions.map((i) => i.name);
    expect(names).not.toContain('subscribe_normal');
    expect(names).not.toContain('subscribeNormal');
  });

  it('carries no instruction under the subscribe_normal discriminator', () => {
    // Name-only checks are dodgeable by a rename; the dispatch key is not.
    const disc = anchorDiscriminator('global:subscribe_normal').join(',');
    const collision = idl.instructions.find((i) => i.discriminator.join(',') === disc);
    expect(collision, `instruction ${collision?.name} answers to global:subscribe_normal`)
      .toBeUndefined();
  });

  it('emits no SubscribeNormalEvent', () => {
    expect(idl.events.map((e) => e.name)).not.toContain('SubscribeNormalEvent');
  });

  it('leaves exactly two ways to open a vault, and both are private', () => {
    // `subscribe_private` (Groth16) and `subscribe_normal` are both gone. The
    // two that remain are the v3 pair (C1 + C3, republishes the note
    // commitment) and the circuit-7 opener `subscribe_private_stark_v4`, which
    // publishes no commitment and binds rate, interval, vk hash and the
    // license commitment into the proof's public inputs
    // (docs/SUBSCRIBE_V4_SPEC-2026-08-26.md). v4 landed on 2026-08-25; this
    // list said "exactly one" until 2026-09-02 and never failed in CI because
    // turbo replayed a cached pass -- the IDL lives outside this package and
    // was not part of the cache key (turbo.json now sets `test.cache: false`).
    // If a THIRD constructor ever appears this fails and someone has to
    // justify it here.
    const openers = idl.instructions
      .map((i) => i.name)
      .filter((n) => /^subscribe/.test(n));
    expect(openers).toEqual(['subscribe_private_stark', 'subscribe_private_stark_v4']);
  });
});

describe('SubscriptionVault layout is unchanged, so the vaults already on chain still decode', () => {
  // The whole justification for deleting only the INSTRUCTION and keeping the
  // `Option<Pubkey> subscriber_pubkey` FIELD is that dropping the field would
  // shift every byte after the discriminator and orphan the live vaults. These
  // two assertions are what make that justification checkable.

  it('keeps the account discriminator Anchor derives for SubscriptionVault', () => {
    const account = idl.accounts.find((a) => a.name === 'SubscriptionVault');
    expect(account).toBeDefined();
    expect(account!.discriminator).toEqual(anchorDiscriminator('account:SubscriptionVault'));
  });

  it('keeps subscriber_pubkey as the first field of the account', () => {
    const type = idl.types.find((t) => t.name === 'SubscriptionVault');
    expect(type, 'SubscriptionVault type missing from IDL').toBeDefined();
    const fields = type!.type.fields ?? [];
    expect(fields[0]?.name).toBe('subscriber_pubkey');
    expect(fields[1]?.name).toBe('subscriber_commitment');
  });
});
