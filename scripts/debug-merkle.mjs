/**
 * Debug Merkle tree root mismatch
 * Fetches all transactions, extracts commitments AND roots,
 * rebuilds tree step by step and compares
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { poseidon2 } from 'poseidon-lite';

const PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');
const SOL_MINT = new PublicKey('11111111111111111111111111111111'); // SystemProgram.programId used as SOL mint
const MERKLE_TREE_DEPTH = 20;

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// --- Byte conversion helpers ---
function bigintToLeBytes(n) {
  const bytes = new Uint8Array(32);
  let temp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(temp & 0xffn);
    temp = temp >> 8n;
  }
  return bytes;
}

function leBytesToBigint(bytes) {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// --- Poseidon hash ---
function poseidonHash(a, b) {
  return poseidon2([a, b]);
}

// --- MerkleTree ---
class MerkleTree {
  constructor(depth) {
    this.depth = depth;
    this.leaves = [];
    this.nodes = new Map();
    this._root = null;
    this._zeroValues = null;
  }

  get root() {
    if (this._root === null) {
      this._root = this.getZeroValue(this.depth);
    }
    return this._root;
  }

  get leafCount() {
    return this.leaves.length;
  }

  getZeroValue(level) {
    if (!this._zeroValues) {
      // LITTLE-ENDIAN interpretation (matches on-chain ZEROS)
      const ZERO_VALUE_BYTES = [
        0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
        0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
        0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
        0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f,
      ];
      let baseZero = 0n;
      for (let i = ZERO_VALUE_BYTES.length - 1; i >= 0; i--) {
        baseZero = (baseZero << 8n) | BigInt(ZERO_VALUE_BYTES[i]);
      }
      this._zeroValues = [baseZero];
      for (let i = 1; i <= this.depth; i++) {
        const prev = this._zeroValues[i - 1];
        this._zeroValues.push(poseidonHash(prev, prev));
      }
    }
    return this._zeroValues[level];
  }

  insert(leaf) {
    const index = this.leaves.length;
    this.leaves.push(leaf);
    let currentHash = leaf;
    let currentIndex = index;
    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = this.getNode(level, siblingIndex);
      this.setNode(level, currentIndex, currentHash);
      currentHash = isRight
        ? poseidonHash(sibling, currentHash)
        : poseidonHash(currentHash, sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }
    this._root = currentHash;
    return this._root;
  }

  getNode(level, index) {
    const key = `${level}-${index}`;
    return this.nodes.get(key) ?? this.getZeroValue(level);
  }

  setNode(level, index, value) {
    const key = `${level}-${index}`;
    this.nodes.set(key, value);
  }
}

// --- Main ---
async function main() {
  // Derive PDAs
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('shielded_pool'), SOL_MINT.toBytes()],
    PROGRAM_ID
  );
  const [merkleTreePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), poolPDA.toBytes()],
    PROGRAM_ID
  );

  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('Merkle Tree PDA:', merkleTreePDA.toBase58());

  // Fetch on-chain state
  const account = await connection.getAccountInfo(merkleTreePDA);
  if (!account) {
    console.error('Merkle tree account not found!');
    return;
  }

  const rootBytes = account.data.slice(8 + 32, 8 + 32 + 32);
  const onChainRoot = leBytesToBigint(rootBytes);
  const leafCount = Number(account.data.readBigUInt64LE(8 + 32 + 32));

  console.log('On-chain root:', onChainRoot.toString());
  console.log('On-chain leaf count:', leafCount);

  // Fetch all transaction signatures
  let signatures = [];
  let lastSig;
  while (true) {
    const batch = await connection.getSignaturesForAddress(
      merkleTreePDA,
      { limit: 100, before: lastSig }
    );
    if (batch.length === 0) break;
    signatures.push(...batch.filter(s => !s.err).map(s => ({
      signature: s.signature,
      slot: s.slot,
    })));
    lastSig = batch[batch.length - 1].signature;
    if (signatures.length > 500) break;
  }

  // Sort by slot (chronological)
  signatures.sort((a, b) => a.slot - b.slot);
  console.log('Total successful transactions:', signatures.length);

  // Process each transaction
  const txData = [];
  for (let i = 0; i < signatures.length; i++) {
    if (i > 0 && i % 3 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }

    let tx;
    for (let retry = 0; retry < 5; retry++) {
      try {
        tx = await connection.getTransaction(signatures[i].signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (tx) break;
      } catch (e) {
        if (e.message?.includes('429') || e.message?.includes('rate')) {
          await new Promise(r => setTimeout(r, 2000 * (retry + 1)));
        } else {
          console.warn(`Failed to fetch tx ${i}:`, e.message);
          break;
        }
      }
    }

    if (!tx?.meta?.logMessages) {
      console.warn(`Could not fetch tx ${i}: ${signatures[i].signature}`);
      continue;
    }

    const logs = tx.meta.logMessages;
    let type = null;
    let leafIndex = null;
    let transferIndices = null;

    for (const log of logs) {
      if (log.includes('Shield') && !log.includes('Unshield')) type = type || 'shield';
      if (log.includes('Unshield')) type = 'unshield';
      if (log.includes('Private transfer completed') || log.includes('Instruction: Transfer')) type = type || 'transfer';

      const indexMatch = log.match(/Commitment added at index: (\d+)/);
      if (indexMatch) leafIndex = parseInt(indexMatch[1], 10);

      const changeIndexMatch = log.match(/Change commitment at index: (\d+)/);
      if (changeIndexMatch) leafIndex = parseInt(changeIndexMatch[1], 10);

      const transferMatch = log.match(/New commitments at indices: (\d+), (\d+)/);
      if (transferMatch) transferIndices = [parseInt(transferMatch[1], 10), parseInt(transferMatch[2], 10)];
    }

    // Extract instruction data
    const msg = tx.transaction.message;
    let ixDataRaw = null;

    if ('compiledInstructions' in msg) {
      const pi = msg.staticAccountKeys.findIndex(k => k.equals(PROGRAM_ID));
      if (pi !== -1) {
        for (const ix of msg.compiledInstructions) {
          if (ix.programIdIndex === pi && ix.data.length >= 48) {
            ixDataRaw = Buffer.from(ix.data);
            break;
          }
        }
      }
    } else {
      for (const ix of msg.instructions) {
        if (ix.programId.equals(PROGRAM_ID)) {
          ixDataRaw = typeof ix.data === 'string' ? Buffer.from(ix.data, 'base64') : Buffer.from(ix.data);
          break;
        }
      }
    }

    if (!ixDataRaw) {
      console.warn(`No program instruction found in tx ${i}`);
      continue;
    }

    // Extract commitment(s) and new_root based on type
    const extractLE = (data, offset) => {
      const bytes = data.slice(offset, offset + 32);
      let c = 0n;
      for (let j = 31; j >= 0; j--) c = (c << 8n) | BigInt(bytes[j]);
      return c;
    };

    if (type === 'shield' && leafIndex !== null) {
      // Layout: disc(8) + amount(8) + commitment(32) + new_root(32)
      const commitment = extractLE(ixDataRaw, 16);
      const newRoot = extractLE(ixDataRaw, 48);
      txData.push({ type, leafIndex, commitments: [{ index: leafIndex, value: commitment }], newRoot, sig: signatures[i].signature.slice(0, 12) });
    } else if (type === 'unshield' && leafIndex !== null) {
      // Layout: disc(8) + proof(256) + null1(32) + null2(32) + change_commit(32) + dummy_commit(32) + merkle_root(32) + amount(8) + new_root(32)
      const OFF = 8 + 256 + 32 + 32; // 328
      const commitment = extractLE(ixDataRaw, OFF);
      // new_root is at: OFF + 32 (change) + 32 (dummy) + 32 (merkle_root) + 8 (amount) = OFF + 104 = 432
      const newRoot = extractLE(ixDataRaw, OFF + 32 + 32 + 32 + 8);
      txData.push({ type, leafIndex, commitments: [{ index: leafIndex, value: commitment }], newRoot, sig: signatures[i].signature.slice(0, 12) });
    } else if (type === 'transfer' && transferIndices) {
      // Layout: disc(8) + proof(256) + null1(32) + null2(32) + commit1(32) + commit2(32) + merkle_root(32) + new_root(32)
      const OFF1 = 8 + 256 + 32 + 32; // 328
      const OFF2 = OFF1 + 32; // 360
      const c1 = extractLE(ixDataRaw, OFF1);
      const c2 = extractLE(ixDataRaw, OFF2);
      // new_root is at OFF2 + 32 (merkle_root) + 32 = OFF2 + 64 = 424
      // Wait... layout is: disc(8) + proof(256) + null1(32) + null2(32) + commit1(32) + commit2(32) + OLD_merkle_root(32) + new_root(32)
      const newRoot = extractLE(ixDataRaw, OFF2 + 32 + 32); // 360 + 64 = 424
      txData.push({ type, leafIndices: transferIndices, commitments: [{ index: transferIndices[0], value: c1 }, { index: transferIndices[1], value: c2 }], newRoot, sig: signatures[i].signature.slice(0, 12) });
    } else {
      console.warn(`Unknown tx type at ${i}: type=${type}, leafIndex=${leafIndex}`);
    }

    process.stdout.write(`\rProcessed ${i + 1}/${signatures.length} transactions...`);
  }
  console.log('\n');

  // Sort by leaf index
  txData.sort((a, b) => {
    const aIdx = a.leafIndex ?? a.leafIndices?.[0] ?? 0;
    const bIdx = b.leafIndex ?? b.leafIndices?.[0] ?? 0;
    return aIdx - bIdx;
  });

  console.log(`Extracted ${txData.length} transaction records`);

  // Build commitment array
  const commitmentMap = new Map();
  for (const td of txData) {
    for (const c of td.commitments) {
      commitmentMap.set(c.index, c.value);
    }
  }

  console.log(`Total unique commitments: ${commitmentMap.size}`);

  // Rebuild tree step by step
  const tree = new MerkleTree(MERKLE_TREE_DEPTH);
  let allMatch = true;

  // Process transactions in order of their leaf indices
  for (const td of txData) {
    // Insert commitment(s)
    for (const c of td.commitments) {
      tree.insert(c.value);
    }

    // Compare root with transaction's new_root
    const localRoot = tree.root;
    const txRoot = td.newRoot;
    const matches = localRoot === txRoot;

    if (!matches) {
      console.log(`\n*** MISMATCH at tx ${td.sig} (${td.type}) ***`);
      console.log(`  Leaf index: ${td.leafIndex ?? td.leafIndices}`);
      console.log(`  Local root:  ${localRoot.toString().slice(0, 30)}...`);
      console.log(`  Tx root:     ${txRoot.toString().slice(0, 30)}...`);
      console.log(`  Tree leaves: ${tree.leafCount}`);

      // Show commitment values
      for (const c of td.commitments) {
        console.log(`  Commitment[${c.index}]: ${c.value.toString().slice(0, 30)}...`);
      }
      allMatch = false;
      // Don't break - continue to see if it's just one tx or all subsequent
    } else {
      const idx = td.leafIndex ?? td.leafIndices?.[0];
      process.stdout.write(`  tx ${td.sig} (${td.type}) leaf=${idx} ✓\n`);
    }
  }

  console.log('\n--- Final comparison ---');
  console.log('Local root:', tree.root.toString());
  console.log('On-chain root:', onChainRoot.toString());
  console.log('Match:', tree.root === onChainRoot);
  console.log('Total leaves in tree:', tree.leafCount);
  console.log('Expected leaves:', leafCount);

  if (allMatch) {
    console.log('\nAll transaction roots matched! The tree is consistent.');
  } else {
    console.log('\nRoot mismatches detected - see above for details.');
  }
}

main().catch(console.error);
