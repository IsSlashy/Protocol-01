/**
 * Verify zero values match between TypeScript and on-chain Rust
 */
import { poseidon2 } from 'poseidon-lite';

// On-chain ZEROS[0] (little-endian bytes)
const ZEROS_ON_CHAIN: number[][] = [
  [0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
   0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
   0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
   0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f],
  [0xf8, 0x22, 0x42, 0x38, 0x88, 0x8e, 0x7a, 0x2e,
   0x1f, 0xa2, 0x15, 0xa6, 0xb0, 0x6b, 0x8c, 0x78,
   0x99, 0xb1, 0xc2, 0x07, 0x86, 0x78, 0xc1, 0xcc,
   0x78, 0x6c, 0xb8, 0x6c, 0x2d, 0x7f, 0xe3, 0x13],
  [0x65, 0x27, 0x62, 0xdc, 0x32, 0x9e, 0x1a, 0xa4,
   0x27, 0xef, 0xdf, 0x5e, 0xf6, 0x0c, 0xd5, 0x3a,
   0xd6, 0x8f, 0xec, 0x3e, 0x80, 0xc2, 0xe8, 0x96,
   0x68, 0x32, 0x2c, 0x35, 0xfa, 0x26, 0x71, 0x21],
];

// Convert LE bytes to bigint
function leBytesToBigint(bytes: number[]): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result;
}

// Convert bigint to LE bytes
function bigintToLeBytes(n: bigint): number[] {
  const bytes: number[] = [];
  let temp = n;
  for (let i = 0; i < 32; i++) {
    bytes.push(Number(temp & BigInt(0xff)));
    temp = temp >> BigInt(8);
  }
  return bytes;
}

console.log('=== Verifying Zero Values ===\n');

// Convert on-chain ZEROS[0] to bigint
const zero0 = leBytesToBigint(ZEROS_ON_CHAIN[0]);
console.log('On-chain ZEROS[0] as bigint:');
console.log('  ', zero0.toString());
console.log('  Hex:', zero0.toString(16));

// Compute ZEROS[1] using poseidon-lite
const computed1 = poseidon2([zero0, zero0]);
console.log('\nComputed ZEROS[1] = Poseidon(ZEROS[0], ZEROS[0]):');
console.log('  ', computed1.toString());
console.log('  Hex:', computed1.toString(16));

// Convert on-chain ZEROS[1] to bigint
const onChain1 = leBytesToBigint(ZEROS_ON_CHAIN[1]);
console.log('\nOn-chain ZEROS[1] as bigint:');
console.log('  ', onChain1.toString());
console.log('  Hex:', onChain1.toString(16));

// Compare
console.log('\n=== Comparison ===');
console.log('ZEROS[1] match:', computed1 === onChain1);

if (computed1 !== onChain1) {
  console.log('\nMISMATCH DETECTED!');
  console.log('Computed LE bytes:', bigintToLeBytes(computed1).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', '));
  console.log('On-chain LE bytes:', ZEROS_ON_CHAIN[1].map(b => '0x' + b.toString(16).padStart(2, '0')).join(', '));
}

// Also compute ZEROS[2]
const computed2 = poseidon2([computed1, computed1]);
const onChain2 = leBytesToBigint(ZEROS_ON_CHAIN[2]);
console.log('\n=== ZEROS[2] ===');
console.log('Computed:', computed2.toString().slice(0, 30) + '...');
console.log('On-chain:', onChain2.toString().slice(0, 30) + '...');
console.log('Match:', computed2 === onChain2);
