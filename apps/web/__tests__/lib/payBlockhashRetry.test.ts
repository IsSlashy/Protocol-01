import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/privacy/pool/ephemeralFunder.ts'), 'utf8');

/** The buyer's payment to the till: the one irreversible step of a relayed deposit. */
const PAY = SRC.slice(
  SRC.indexOf("req.onProgress?.('Paying the deployment"),
  SRC.indexOf('rememberRelayPayment({'),
);

describe('the payment survives a slow wallet click', () => {
  it('does not take a finalized blockhash into a wallet prompt', () => {
    // A finalized blockhash arrives ~32 slots old, so it enters the prompt with
    // a fifth of its ~90s life already spent. MEASURED 2026-08-28: a shield died
    // on "Blockhash not found" while the popup waited for a click.
    expect(PAY).toContain("getLatestBlockhash('confirmed')");
    expect(PAY).not.toContain("getLatestBlockhash('finalized')");
  });

  it('retries an EXPIRED blockhash, and says why it is asking again', () => {
    expect(PAY).toMatch(/blockhash not found\|block height exceeded/i);
    expect(PAY).toMatch(/nothing was sent/i);
  });

  it('🚨 retries at most once, so a stuck wallet cannot loop the user', () => {
    expect(PAY).toMatch(/attempt >= 1/);
  });

  it('⛔ never retries an error that is not an expiry', () => {
    // Retrying a send that may have reached the network is how a buyer pays the
    // till twice for one note. Only a preflight failure is safe, because a
    // transaction refused at preflight was never forwarded.
    expect(PAY).toMatch(/if \(!expired \|\| attempt >= 1\) throw e;/);
  });

  it('still pays the till and the fee wallet in ONE transaction', () => {
    // Two transactions would let a buyer approve the deposit and drop the fee.
    const builder = SRC.slice(SRC.indexOf('function buildPayTx('), SRC.indexOf('return payTx;'));
    expect(builder.match(/SystemProgram\.transfer\(/g)).toHaveLength(2);
    expect(builder).toContain('terms.till');
    expect(builder).toContain('terms.feeWallet');
  });
});
