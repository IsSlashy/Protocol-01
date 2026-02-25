/**
 * Test relayer zkSPL proof endpoints with valid circuit inputs.
 * Uses circomlibjs Poseidon to compute proper commitments.
 */
import { buildPoseidon } from 'circomlibjs';

const RELAYER_URL = 'https://p01-relayer-production.up.railway.app';

async function main() {
  console.log('Building Poseidon hasher...');
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Helper: Poseidon hash -> decimal string
  const hash = (...inputs) => F.toString(poseidon(inputs));

  // Derive owner_pubkey from spending_key: owner = Poseidon(spending_key)
  const spending_key = '42424242424242';
  const owner_pubkey = hash(BigInt(spending_key));
  const mint = '99887766554433221100';

  console.log(`spending_key: ${spending_key}`);
  console.log(`owner_pubkey (derived): ${owner_pubkey}`);

  // =========================================================================
  // TEST 1: DEPOSIT (public_credit = 100)
  // =========================================================================
  console.log('\n=== TEST 1: DEPOSIT ===');
  const dep_old_balance = '0';
  const dep_old_salt = '111111';
  const dep_new_balance = '100';
  const dep_new_salt = '222222';

  const dep_old_commitment = hash(
    BigInt(dep_old_balance), BigInt(dep_old_salt), BigInt(owner_pubkey), BigInt(mint)
  );
  const dep_new_commitment = hash(
    BigInt(dep_new_balance), BigInt(dep_new_salt), BigInt(owner_pubkey), BigInt(mint)
  );
  const zero_amount_hash = hash(BigInt(0), BigInt(0));

  // Conservation: old(0) + public_credit(100) = new(100) + public_debit(0) ✓
  const depositInputs = {
    old_commitment: dep_old_commitment,
    new_commitment: dep_new_commitment,
    amount_hash: zero_amount_hash,
    public_credit: '100',
    public_debit: '0',
    token_mint: mint,
    nonce: '0',
    old_balance: dep_old_balance,
    old_salt: dep_old_salt,
    new_balance: dep_new_balance,
    new_salt: dep_new_salt,
    amount: '0',
    amount_salt: '0',
    spending_key: spending_key,
    is_debit: '0',
  };

  console.log('Commitment check:');
  console.log(`  old_commitment: ${dep_old_commitment}`);
  console.log(`  new_commitment: ${dep_new_commitment}`);
  console.log(`  amount_hash: ${zero_amount_hash}`);
  console.log('Sending deposit proof request...');

  const t1 = Date.now();
  try {
    const res = await fetch(`${RELAYER_URL}/api/zkspl/prove/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: depositInputs }),
    });
    const data = await res.json();
    console.log(`Status: ${res.status} (${Date.now() - t1}ms)`);
    if (data.proof) {
      console.log('DEPOSIT PROOF OK');
      console.log(`  prover: ${data.prover}`);
      console.log(`  proofTimeMs: ${data.proofTimeMs}`);
      console.log(`  totalTimeMs: ${data.totalTimeMs}`);
      console.log(`  publicSignals: [${data.publicSignals?.length} signals]`);
      console.log(`  signals: ${JSON.stringify(data.publicSignals)}`);
    } else {
      console.log('DEPOSIT FAILED:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('DEPOSIT ERROR:', err.message);
  }

  // =========================================================================
  // TEST 2: WITHDRAW (public_debit = 50)
  // =========================================================================
  console.log('\n=== TEST 2: WITHDRAW ===');
  const wd_old_balance = '100';
  const wd_old_salt = '222222';
  const wd_new_balance = '50';
  const wd_new_salt = '333333';

  const wd_old_commitment = hash(
    BigInt(wd_old_balance), BigInt(wd_old_salt), BigInt(owner_pubkey), BigInt(mint)
  );
  const wd_new_commitment = hash(
    BigInt(wd_new_balance), BigInt(wd_new_salt), BigInt(owner_pubkey), BigInt(mint)
  );

  // Conservation: old(100) + public_credit(0) = new(50) + public_debit(50) ✓
  const withdrawInputs = {
    old_commitment: wd_old_commitment,
    new_commitment: wd_new_commitment,
    amount_hash: zero_amount_hash,
    public_credit: '0',
    public_debit: '50',
    token_mint: mint,
    nonce: '1',
    old_balance: wd_old_balance,
    old_salt: wd_old_salt,
    new_balance: wd_new_balance,
    new_salt: wd_new_salt,
    amount: '0',
    amount_salt: '0',
    spending_key: spending_key,
    is_debit: '0',
  };

  console.log('Sending withdraw proof request...');
  const t2 = Date.now();
  try {
    const res = await fetch(`${RELAYER_URL}/api/zkspl/prove/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: withdrawInputs }),
    });
    const data = await res.json();
    console.log(`Status: ${res.status} (${Date.now() - t2}ms)`);
    if (data.proof) {
      console.log('WITHDRAW PROOF OK');
      console.log(`  prover: ${data.prover}`);
      console.log(`  proofTimeMs: ${data.proofTimeMs}`);
      console.log(`  totalTimeMs: ${data.totalTimeMs}`);
      console.log(`  publicSignals: [${data.publicSignals?.length} signals]`);
    } else {
      console.log('WITHDRAW FAILED:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('WITHDRAW ERROR:', err.message);
  }

  // =========================================================================
  // TEST 3: TRANSFER (is_debit=1, amount=30, private_debit=30)
  // =========================================================================
  console.log('\n=== TEST 3: TRANSFER (send) ===');
  const tx_old_balance = '50';
  const tx_old_salt = '333333';
  const tx_new_balance = '20';
  const tx_new_salt = '444444';
  const tx_amount = '30';
  const tx_amount_salt = '555555';

  const tx_old_commitment = hash(
    BigInt(tx_old_balance), BigInt(tx_old_salt), BigInt(owner_pubkey), BigInt(mint)
  );
  const tx_new_commitment = hash(
    BigInt(tx_new_balance), BigInt(tx_new_salt), BigInt(owner_pubkey), BigInt(mint)
  );
  const tx_amount_hash = hash(BigInt(tx_amount), BigInt(tx_amount_salt));

  // Conservation: old(50) + private_credit(0) + public_credit(0)
  //             = new(20) + private_debit(30) + public_debit(0)
  // private_debit = is_debit(1) * amount(30) = 30 ✓
  const transferInputs = {
    old_commitment: tx_old_commitment,
    new_commitment: tx_new_commitment,
    amount_hash: tx_amount_hash,
    public_credit: '0',
    public_debit: '0',
    token_mint: mint,
    nonce: '2',
    old_balance: tx_old_balance,
    old_salt: tx_old_salt,
    new_balance: tx_new_balance,
    new_salt: tx_new_salt,
    amount: tx_amount,
    amount_salt: tx_amount_salt,
    spending_key: spending_key,
    is_debit: '1',
  };

  console.log(`  amount_hash: ${tx_amount_hash}`);
  console.log('Sending transfer proof request...');
  const t3 = Date.now();
  try {
    const res = await fetch(`${RELAYER_URL}/api/zkspl/prove/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: transferInputs }),
    });
    const data = await res.json();
    console.log(`Status: ${res.status} (${Date.now() - t3}ms)`);
    if (data.proof) {
      console.log('TRANSFER PROOF OK');
      console.log(`  prover: ${data.prover}`);
      console.log(`  proofTimeMs: ${data.proofTimeMs}`);
      console.log(`  totalTimeMs: ${data.totalTimeMs}`);
      console.log(`  publicSignals: [${data.publicSignals?.length} signals]`);
    } else {
      console.log('TRANSFER FAILED:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('TRANSFER ERROR:', err.message);
  }

  console.log('\n=== ALL TESTS COMPLETE ===');
}

main().catch(console.error);
