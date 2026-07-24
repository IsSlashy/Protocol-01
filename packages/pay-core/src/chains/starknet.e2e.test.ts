/**
 * Starknet FULL-FLOW e2e against a local starknet-devnet (WSL):
 *   derive identity → send STRK to a PQ-derived stealth account (ERC-20
 *   transfer + pq_announcer announcement in ONE multicall) → recipient scans
 *   the chain, decapsulates, derives the account → deploys it counterfactually
 *   and sweeps the funds to a destination wallet.
 *
 * Requires:
 *   starknet-devnet --seed 42 --port 5050        (running in WSL)
 *   PqAnnouncer deployed (sncast declare+deploy)
 * Gate: PQ_E2E=1 pnpm vitest run starknet.e2e
 */
import { describe, it, expect } from 'vitest';
import { Account, RpcProvider } from 'starknet';
import {
  starknetAdapter,
  configureStarknet,
  setStarknetSignerRuntime,
  STARKNET_TOKENS,
} from './starknet';
import { STRK_STARKNET } from '../assets';

const NODE_URL = process.env.DEVNET_URL ?? 'http://127.0.0.1:5050/rpc';
const ANNOUNCER = process.env.PQ_ANNOUNCER_ADDRESS ??
  '0x04caeeea34729eae3f6ad58cafd21fad5f65d6e33d1375a62a187a95c00f3534';
/** Devnet (seed 42) predeployed account class — used for stealth accounts too. */
const DEVNET_ACCOUNT_CLASS =
  '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564';

const SENDER = {
  address: '0x034ba56f92265f0868c57d3fe72ecab144fc96f97954bbbc4252cef8e8a979ba',
  privateKey: '0x00000000000000000000000000000000b137668388dbe9acdfa3bc734cc2c469',
};
const DEST = '0x02939f2dc3f80cc7d620e8a86f2e69c1e187b7ff44b74056647368b5c49dc370';

const gate = process.env.PQ_E2E === '1' ? describe : describe.skip;

gate('Starknet PQ stealth — full flow on local devnet', () => {
  it('send → announce → scan → decapsulate → deploy → sweep', async () => {
    const provider = new RpcProvider({ nodeUrl: NODE_URL });
    const sender = new Account({
      provider,
      address: SENDER.address,
      signer: SENDER.privateKey,
    });

    configureStarknet({
      nodeUrl: NODE_URL,
      announcerAddress: ANNOUNCER,
      accountClassHash: DEVNET_ACCOUNT_CLASS,
      claimCushionWei: 10n ** 18n, // 1 STRK
    });
    setStarknetSignerRuntime({ account: sender, address: SENDER.address });

    // Fresh recipient identity per run (a reused meta would rediscover claim
    // residue from earlier runs against the same devnet).
    const fakeSig = crypto.getRandomValues(new Uint8Array(64));
    const identity = await starknetAdapter.deriveMeta(fakeSig);
    expect(identity.meta.startsWith('st')).toBe(true);

    // SEND: 5 STRK privately (recipient hidden behind a one-time account).
    const sendRef = await starknetAdapter.send({
      recipient: { meta: identity.meta, version: 2, label: 'e2e recipient' },
      asset: STRK_STARKNET,
      amount: 5,
    });
    expect(sendRef.signature).toMatch(/^0x/);
    await provider.waitForTransaction(sendRef.signature);

    // SCAN: recipient discovers the payment from chain data alone.
    const payments = await starknetAdapter.scan(identity);
    const strkPayment = payments.find((p) => p.assetSymbol === 'STRK');
    expect(strkPayment).toBeDefined();
    // 5 STRK + 1 STRK claim cushion at the stealth account.
    expect(strkPayment!.amount).toBeGreaterThanOrEqual(5.9);
    expect(strkPayment!.stealthAddress).not.toBe(SENDER.address);

    // CLAIM: deploy the counterfactual account + sweep to the destination.
    const before = await provider.callContract({
      contractAddress: STARKNET_TOKENS.STRK!,
      entrypoint: 'balanceOf',
      calldata: [DEST],
    });
    const beforeBal = BigInt(before[0]!) + (BigInt(before[1]!) << 128n);

    const claimRef = await starknetAdapter.claim(strkPayment!, identity, DEST);
    expect(claimRef.signature).toMatch(/^0x/);
    await provider.waitForTransaction(claimRef.signature);

    const after = await provider.callContract({
      contractAddress: STARKNET_TOKENS.STRK!,
      entrypoint: 'balanceOf',
      calldata: [DEST],
    });
    const afterBal = BigInt(after[0]!) + (BigInt(after[1]!) << 128n);

    // Destination received at least 5 STRK (cushion minus fees may add more).
    expect(afterBal - beforeBal).toBeGreaterThanOrEqual(5n * 10n ** 18n);
  }, 180_000);
});
