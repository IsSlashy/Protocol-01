/**
 * Check tokenMint encoding consistency
 */
import { SystemProgram } from '@solana/web3.js';
import { poseidon4 } from 'poseidon-lite';

const TOKEN_MINT = SystemProgram.programId;

console.log('=== Token Mint Encoding ===\n');

// Method 1: Current app code (big-endian hex)
const tokenMintBE = BigInt('0x' + Buffer.from(TOKEN_MINT.toBytes()).toString('hex'));
console.log('Method 1 (BE hex conversion):');
console.log('  Value:', tokenMintBE.toString());
console.log('  Hex:  ', tokenMintBE.toString(16));

// Method 2: Little-endian conversion (like we do for commitments)
const bytes = TOKEN_MINT.toBytes();
let tokenMintLE = BigInt(0);
for (let i = bytes.length - 1; i >= 0; i--) {
  tokenMintLE = (tokenMintLE << BigInt(8)) | BigInt(bytes[i]);
}
console.log('\nMethod 2 (LE conversion):');
console.log('  Value:', tokenMintLE.toString());
console.log('  Hex:  ', tokenMintLE.toString(16));

// System Program ID bytes
console.log('\nSystem Program ID bytes (should be all zeros):');
console.log('  ', Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '));

// Since SystemProgram.programId is all zeros, both methods give 0
console.log('\nBoth methods equal?', tokenMintBE === tokenMintLE);
console.log('Both are zero?', tokenMintBE === BigInt(0));

// Test commitment calculation
const amount = BigInt(1000000000); // 1 SOL
const ownerPubkey = BigInt('12345678901234567890'); // fake pubkey
const randomness = BigInt('98765432109876543210'); // fake randomness

console.log('\n=== Commitment Test ===');
console.log('Amount:', amount.toString());
console.log('OwnerPubkey:', ownerPubkey.toString());
console.log('Randomness:', randomness.toString());
console.log('TokenMint:', tokenMintBE.toString());

const commitment = poseidon4([amount, ownerPubkey, randomness, tokenMintBE]);
console.log('\nCommitment:', commitment.toString());
console.log('Commitment hex:', commitment.toString(16));
