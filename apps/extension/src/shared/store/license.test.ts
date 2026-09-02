/**
 * The license store can REBUILD a key, not only replay one.
 *
 * A private license key is `licenseKeyForPrivate(noteSecret, serviceTag)`. The
 * note secret is already on disk in the vault store (FIX B saved it before the
 * subscribe tx). Until 2026-09-02 the tag was nowhere, so a vault whose popup
 * closed before the late mint had a commitment on chain and no key anywhere.
 * These assertions pin the rebuild and the list that offers it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useLicenseStore } from './license';
import { useSubscriptionVaultStore } from './subscriptionVault';
import { licenseKeyForPrivate } from '../services/license';

const VAULT_A = 'VaultA1111111111111111111111111111111111111';
const VAULT_B = 'VaultB1111111111111111111111111111111111111';
const RETAILER = 'Reta11er111111111111111111111111111111111';
const SECRET_A = 123456789012345678n;
const SECRET_B = 987654321n;

beforeEach(() => {
  useLicenseStore.getState().reset();
  // Legacy plaintext entries: `getSecret` returns them as-is, so no session
  // password is needed here. The encrypted path is exercised by
  // services/subscriptionVault.licenseOrder.test.ts.
  useSubscriptionVaultStore.setState({
    subscriberSecrets: { [VAULT_A]: SECRET_A.toString(), [VAULT_B]: SECRET_B.toString() },
  });
});

describe('deriveLicenseForVault', () => {
  it('rebuilds exactly the key subscribe would have minted', async () => {
    useLicenseStore.getState().recordVaultTag({
      vaultAddress: VAULT_A,
      retailer: RETAILER,
      serviceTag: 'acme',
      serviceName: 'Acme Reader',
    });
    const entry = await useLicenseStore.getState().deriveLicenseForVault(VAULT_A);
    expect(entry?.licenseKey).toBe(licenseKeyForPrivate(SECRET_A, 'acme'));
    expect(entry?.retailer).toBe(RETAILER);
    expect(entry?.mode).toBe('zk');
    expect(entry?.serviceName).toBe('Acme Reader');
    expect(entry?.vaultAddress).toBe(VAULT_A);
    expect(entry?.serviceTag).toBe('acme');
  });

  it('is null without a tag, and null without a secret', async () => {
    expect(await useLicenseStore.getState().deriveLicenseForVault(VAULT_A)).toBeNull();

    useLicenseStore.getState().recordVaultTag({
      vaultAddress: 'VaultUnknown',
      retailer: RETAILER,
      serviceTag: 'acme',
    });
    expect(await useLicenseStore.getState().deriveLicenseForVault('VaultUnknown')).toBeNull();
  });
});

describe('saveLicense', () => {
  it('files the vault tag and marks it confirmed when the entry names its vault', () => {
    useLicenseStore.getState().saveLicense({
      licenseKey: 'P01-TEST',
      retailer: RETAILER,
      mode: 'zk',
      createdAt: 1_000,
      vaultAddress: VAULT_A,
      serviceTag: 'acme',
    });
    const tag = useLicenseStore.getState().vaultTags[VAULT_A];
    expect(tag?.serviceTag).toBe('acme');
    expect(tag?.confirmedAt).toBe(1_000);
  });

  it('keeps an earlier recordVaultTag timestamp and only adds the confirmation', () => {
    useLicenseStore.getState().recordVaultTag({
      vaultAddress: VAULT_A,
      retailer: RETAILER,
      serviceTag: 'acme',
    });
    const recordedAt = useLicenseStore.getState().vaultTags[VAULT_A].recordedAt;
    useLicenseStore.getState().saveLicense({
      licenseKey: 'P01-TEST',
      retailer: RETAILER,
      mode: 'zk',
      createdAt: recordedAt + 5_000,
      vaultAddress: VAULT_A,
      serviceTag: 'acme',
    });
    const tag = useLicenseStore.getState().vaultTags[VAULT_A];
    expect(tag.recordedAt).toBe(recordedAt);
    expect(tag.confirmedAt).toBe(recordedAt + 5_000);
  });
});

describe('presentableLicenses', () => {
  it('offers one key per known vault, minted or rebuilt, and flags the unconfirmed one', async () => {
    const store = useLicenseStore.getState();
    // Vault A: minted at purchase, the normal case.
    store.saveLicense({
      licenseKey: licenseKeyForPrivate(SECRET_A, 'acme'),
      retailer: RETAILER,
      mode: 'zk',
      serviceName: 'Acme Reader',
      createdAt: 2_000,
      vaultAddress: VAULT_A,
      serviceTag: 'acme',
    });
    // Vault B: the defect window. The tag was recorded before the tx, the
    // confirmation was never seen here, and no key was ever minted.
    store.recordVaultTag({
      vaultAddress: VAULT_B,
      retailer: 'Other111111111111111111111111111111111111',
      serviceTag: 'other',
      serviceName: 'Other',
    });

    const list = await useLicenseStore.getState().presentableLicenses();
    const byVault = Object.fromEntries(list.map((l) => [l.vaultAddress, l]));

    expect(Object.keys(byVault).sort()).toEqual([VAULT_A, VAULT_B].sort());
    expect(byVault[VAULT_A].confirmed).toBe(true);
    expect(byVault[VAULT_A].licenseKey).toBe(licenseKeyForPrivate(SECRET_A, 'acme'));
    expect(byVault[VAULT_B].confirmed).toBe(false);
    expect(byVault[VAULT_B].licenseKey).toBe(licenseKeyForPrivate(SECRET_B, 'other'));
  });

  it('keeps a second subscription to the same merchant presentable', async () => {
    // `licenses` is keyed by retailer, so the second mint overwrites the first
    // entry there. The vault tags are keyed by vault, so both keys survive.
    const store = useLicenseStore.getState();
    store.saveLicense({
      licenseKey: licenseKeyForPrivate(SECRET_A, 'acme'),
      retailer: RETAILER,
      mode: 'zk',
      createdAt: 1_000,
      vaultAddress: VAULT_A,
      serviceTag: 'acme',
    });
    store.saveLicense({
      licenseKey: licenseKeyForPrivate(SECRET_B, 'acme'),
      retailer: RETAILER,
      mode: 'zk',
      createdAt: 2_000,
      vaultAddress: VAULT_B,
      serviceTag: 'acme',
    });
    expect(Object.keys(useLicenseStore.getState().licenses)).toHaveLength(1);

    const keys = (await useLicenseStore.getState().presentableLicenses()).map((l) => l.licenseKey);
    expect(keys).toContain(licenseKeyForPrivate(SECRET_A, 'acme'));
    expect(keys).toContain(licenseKeyForPrivate(SECRET_B, 'acme'));
  });

  it('still lists a key minted before vault addresses were recorded', async () => {
    useLicenseStore.getState().saveLicense({
      licenseKey: 'P01-LEGACY',
      retailer: RETAILER,
      mode: 'zk',
      createdAt: 1,
    });
    const list = await useLicenseStore.getState().presentableLicenses();
    expect(list).toHaveLength(1);
    expect(list[0].licenseKey).toBe('P01-LEGACY');
    expect(list[0].confirmed).toBe(true);
  });
});
