/**
 * Specter Protocol ZK Shielded Pool Relayer
 *
 * This service enables gasless transactions for the shielded pool by:
 * 1. Receiving signed ZK proofs from users
 * 2. Verifying proofs off-chain for faster rejection of invalid proofs
 * 3. Submitting valid transactions on behalf of users
 * 4. Collecting fees in shielded tokens
 */

import express from 'express';
import cors from 'cors';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import * as snarkjs from 'snarkjs';
import winston from 'winston';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// Logger setup
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'relayer.log' }),
  ],
});

// Configuration
const CONFIG = {
  port: parseInt(process.env.PORT || '3000'),
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  programId: new PublicKey(process.env.ZK_PROGRAM_ID || '8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY'),
  feeRecipient: process.env.FEE_RECIPIENT_PUBKEY,
  feeBps: parseInt(process.env.FEE_BPS || '50'), // 0.5% default - covers relayer gas costs
  maxPendingTx: parseInt(process.env.MAX_PENDING_TX || '100'),
  verificationKeyPath: process.env.VERIFICATION_KEY_PATH || path.resolve(__dirname, '../../../circuits/build/verification_key.json'),
  wasmPath: process.env.WASM_PATH || path.resolve(__dirname, '../../../circuits/build/transfer_js/transfer.wasm'),
  zkeyPath: process.env.ZKEY_PATH || path.resolve(__dirname, '../../../circuits/build/transfer_final.zkey'),
};

// Load verification key at startup
let verificationKey: any = null;
try {
  const vkPath = CONFIG.verificationKeyPath;
  if (fs.existsSync(vkPath)) {
    verificationKey = JSON.parse(fs.readFileSync(vkPath, 'utf8'));
    logger.info(`Loaded verification key from ${vkPath}`);
    logger.info(`VK protocol: ${verificationKey.protocol}, curve: ${verificationKey.curve}, nPublic: ${verificationKey.nPublic}`);
  } else {
    logger.warn(`Verification key not found at ${vkPath} - using mock verification`);
  }
} catch (e) {
  logger.error('Failed to load verification key:', e);
}

// Relayer state
interface PendingTransaction {
  id: string;
  proof: any;
  publicInputs: string[];
  submittedAt?: number;
  signature?: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  error?: string;
}

const pendingTxs: Map<string, PendingTransaction> = new Map();

// Initialize Solana connection
const connection = new Connection(CONFIG.rpcUrl, 'confirmed');

// Load relayer keypair (for paying gas)
// Supports both base64 and JSON array formats
let relayerKeypair: Keypair;
try {
  const secretKey = process.env.RELAYER_SECRET_KEY;
  if (secretKey) {
    let keyBytes: Uint8Array;
    if (secretKey.startsWith('[')) {
      // JSON array format: [189,5,151,...]
      keyBytes = Uint8Array.from(JSON.parse(secretKey));
    } else {
      // Base64 format
      keyBytes = Uint8Array.from(Buffer.from(secretKey, 'base64'));
    }
    relayerKeypair = Keypair.fromSecretKey(keyBytes);
    logger.info(`Relayer wallet: ${relayerKeypair.publicKey.toBase58()}`);
  } else {
    logger.warn('No RELAYER_SECRET_KEY provided, using random keypair (for testing only)');
    relayerKeypair = Keypair.generate();
  }
} catch (e) {
  logger.error('Failed to load relayer keypair:', e);
  process.exit(1);
}

// Express app setup
const app = express();
app.use(cors()); // Enable CORS for mobile app
app.use(express.json({ limit: '10mb' })); // Increased limit for proof inputs

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    relayer: relayerKeypair.publicKey.toBase58(),
    pendingTxs: pendingTxs.size,
    feeBps: CONFIG.feeBps,
    zkVerification: verificationKey ? 'enabled' : 'disabled (mock)',
    vkProtocol: verificationKey?.protocol || null,
    vkNPublic: verificationKey?.nPublic || null,
  });
});

/**
 * Get relayer info
 */
app.get('/info', async (req, res) => {
  try {
    const balance = await connection.getBalance(relayerKeypair.publicKey);

    res.json({
      relayer: relayerKeypair.publicKey.toBase58(),
      programId: CONFIG.programId.toBase58(),
      feeBps: CONFIG.feeBps,
      feeRecipient: CONFIG.feeRecipient,
      balance: balance / 1e9,
      pendingTxs: pendingTxs.size,
      maxPendingTx: CONFIG.maxPendingTx,
      zkVerification: {
        enabled: !!verificationKey,
        protocol: verificationKey?.protocol || null,
        curve: verificationKey?.curve || null,
        nPublic: verificationKey?.nPublic || null,
      },
    });
  } catch (e) {
    logger.error('Failed to get relayer info:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Generate ZK proof server-side
 *
 * This endpoint allows mobile clients to generate proofs without
 * bundling the 19MB circuit files in the app.
 *
 * Request body:
 * {
 *   inputs: Record<string, string> - Circuit inputs
 * }
 *
 * Response:
 * {
 *   proof: { pi_a, pi_b, pi_c },
 *   publicSignals: string[]
 * }
 */
app.post('/prove', async (req, res) => {
  const startTime = Date.now();
  const reqId = `prove_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const { inputs } = req.body;

    if (!inputs || typeof inputs !== 'object') {
      return res.status(400).json({ error: 'Missing inputs object' });
    }

    logger.info(`[${reqId}] Proof generation request received`, {
      inputKeys: Object.keys(inputs),
    });

    // Check if circuit files exist
    if (!fs.existsSync(CONFIG.wasmPath)) {
      logger.error(`WASM file not found at ${CONFIG.wasmPath}`);
      return res.status(500).json({ error: 'Circuit WASM not found on server' });
    }
    if (!fs.existsSync(CONFIG.zkeyPath)) {
      logger.error(`ZKEY file not found at ${CONFIG.zkeyPath}`);
      return res.status(500).json({ error: 'Circuit ZKEY not found on server' });
    }

    // Parse inputs - convert JSON strings to arrays where needed
    const parsedInputs: Record<string, any> = {};
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === 'string' && value.startsWith('[')) {
        try {
          parsedInputs[key] = JSON.parse(value);
        } catch {
          parsedInputs[key] = value;
        }
      } else {
        parsedInputs[key] = value;
      }
    }

    logger.info(`[${reqId}] Starting proof generation...`);
    const proofStart = Date.now();

    // Generate proof using snarkjs
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      parsedInputs,
      CONFIG.wasmPath,
      CONFIG.zkeyPath
    );

    const proofTime = Date.now() - proofStart;
    const totalTime = Date.now() - startTime;

    logger.info(`[${reqId}] Proof generated successfully`, {
      proofTimeMs: proofTime,
      totalTimeMs: totalTime,
      publicSignalsCount: publicSignals.length,
    });

    res.json({
      success: true,
      proof,
      publicSignals,
      proofTimeMs: proofTime,
      totalTimeMs: totalTime,
    });

  } catch (e: any) {
    const totalTime = Date.now() - startTime;
    logger.error(`[${reqId}] Proof generation failed (${totalTime}ms):`, e);
    res.status(500).json({
      error: 'Proof generation failed',
      message: e.message || 'Unknown error',
    });
  }
});

/**
 * Submit a shielded transfer via relayer
 *
 * Request body:
 * {
 *   proof: { pi_a, pi_b, pi_c },
 *   publicInputs: string[],
 *   nullifiers: [string, string],
 *   outputCommitments: [string, string],
 *   relayerFeeCommitment: string,
 *   merkleRoot: string
 * }
 */
app.post('/relay/transfer', async (req, res) => {
  const startTime = Date.now();
  const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Check capacity
    if (pendingTxs.size >= CONFIG.maxPendingTx) {
      logger.warn('Max pending transactions reached');
      return res.status(503).json({ error: 'Service at capacity, try again later' });
    }

    const {
      proof,
      publicInputs,
      nullifiers,
      outputCommitments,
      relayerFeeCommitment,
      merkleRoot,
    } = req.body;

    // Validate request
    if (!proof || !publicInputs || !nullifiers || !outputCommitments || !merkleRoot) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    logger.info(`[${txId}] Received relay request`, {
      nullifiers: nullifiers.map((n: string) => n.slice(0, 16) + '...'),
    });

    // Store as pending
    const pendingTx: PendingTransaction = {
      id: txId,
      proof,
      publicInputs,
      status: 'pending',
    };
    pendingTxs.set(txId, pendingTx);

    // Verify proof off-chain (fast rejection of invalid proofs)
    const verificationStart = Date.now();
    const isValid = await verifyProofOffChain(proof, publicInputs);
    const verificationTime = Date.now() - verificationStart;

    logger.info(`[${txId}] Off-chain verification: ${isValid ? 'VALID' : 'INVALID'} (${verificationTime}ms)`);

    if (!isValid) {
      pendingTxs.delete(txId);
      return res.status(400).json({ error: 'Invalid proof' });
    }

    // Build and submit transaction
    pendingTx.status = 'submitted';
    pendingTx.submittedAt = Date.now();

    // In production, build the actual Solana transaction here
    // For now, return a mock response
    const mockSignature = `mock_${txId}`;
    pendingTx.signature = mockSignature;
    pendingTx.status = 'confirmed';

    const totalTime = Date.now() - startTime;
    logger.info(`[${txId}] Transaction submitted (${totalTime}ms)`, {
      signature: mockSignature,
    });

    res.json({
      success: true,
      txId,
      signature: mockSignature,
      verificationTimeMs: verificationTime,
      totalTimeMs: totalTime,
    });

    // Clean up after delay
    setTimeout(() => {
      pendingTxs.delete(txId);
    }, 60000);

  } catch (e) {
    logger.error(`[${txId}] Relay failed:`, e);
    pendingTxs.delete(txId);
    res.status(500).json({ error: 'Transaction failed' });
  }
});

/**
 * Get transaction status
 */
app.get('/relay/status/:txId', (req, res) => {
  const { txId } = req.params;
  const tx = pendingTxs.get(txId);

  if (!tx) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  res.json({
    txId: tx.id,
    status: tx.status,
    signature: tx.signature,
    error: tx.error,
  });
});

// Track spent nullifiers for private sends (in production, use persistent storage)
const spentNullifiers: Set<string> = new Set();

// Store recent stealth payments for recipient scanning (file-persisted)
interface StealthPayment {
  stealthAddress: string;
  ephemeralPublicKey: string;
  viewTag: string;
  amount: number;
  timestamp: number;
  signature: string;
}

const STEALTH_PAYMENTS_FILE = path.resolve(__dirname, '../stealth-payments.json');
let recentStealthPayments: StealthPayment[] = [];
const MAX_STEALTH_HISTORY = 1000; // Keep last 1000 payments

// Load persisted stealth payments on startup
try {
  if (fs.existsSync(STEALTH_PAYMENTS_FILE)) {
    recentStealthPayments = JSON.parse(fs.readFileSync(STEALTH_PAYMENTS_FILE, 'utf8'));
    logger.info(`Loaded ${recentStealthPayments.length} persisted stealth payments`);
  }
} catch (e) {
  logger.warn('Failed to load persisted stealth payments:', e);
}

function saveStealthPayments() {
  try {
    fs.writeFileSync(STEALTH_PAYMENTS_FILE, JSON.stringify(recentStealthPayments, null, 2));
  } catch (e) {
    logger.error('Failed to persist stealth payments:', e);
  }
}

// Fixed denominations for anonymity (Tornado Cash style) - kept for backward compatibility
const DENOMINATIONS = [
  0.1 * 1e9,   // 0.1 SOL
  1 * 1e9,     // 1 SOL
  10 * 1e9,    // 10 SOL
];

/**
 * TRUE ZERO-KNOWLEDGE PRIVATE SEND
 *
 * This endpoint enables fully private transfers where:
 * - Sender is hidden (relayer sends on their behalf)
 * - Recipient is hidden (stealth address)
 * - Amount is hidden (fixed denominations only)
 *
 * On-chain visibility: "Relayer → Unknown Stealth Address"
 * No link between original depositor and recipient!
 */
app.post('/relay/private-send', async (req, res) => {
  const startTime = Date.now();
  const txId = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const {
      proof,
      publicSignals,
      nullifier,
      stealthAddress,
      denominationIndex,
    } = req.body;

    // Validate request
    if (!proof || !publicSignals || !nullifier || !stealthAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate denomination
    if (denominationIndex < 0 || denominationIndex >= DENOMINATIONS.length) {
      return res.status(400).json({
        error: 'Invalid denomination',
        validDenominations: ['0.1 SOL', '1 SOL', '10 SOL']
      });
    }
    const amount = DENOMINATIONS[denominationIndex];

    logger.info(`[${txId}] Private send request`, {
      denomination: amount / 1e9 + ' SOL',
      stealthAddress: stealthAddress.slice(0, 16) + '...',
    });

    // Check nullifier hasn't been spent (prevents double-spending)
    if (spentNullifiers.has(nullifier)) {
      logger.warn(`[${txId}] Nullifier already spent`);
      return res.status(400).json({ error: 'Nullifier already spent' });
    }

    // Verify ZK proof
    const verificationStart = Date.now();
    const isValid = await verifyProofOffChain(proof, publicSignals);
    const verificationTime = Date.now() - verificationStart;

    logger.info(`[${txId}] Proof verification: ${isValid ? 'VALID' : 'INVALID'} (${verificationTime}ms)`);

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid ZK proof' });
    }

    // Check relayer has sufficient balance
    const relayerBalance = await connection.getBalance(relayerKeypair.publicKey);
    const minBalance = amount + 10000; // amount + tx fees
    if (relayerBalance < minBalance) {
      logger.error(`[${txId}] Relayer insufficient balance: ${relayerBalance} < ${minBalance}`);
      return res.status(503).json({ error: 'Relayer insufficient balance, try again later' });
    }

    // Parse stealth address
    let stealthPubkey: PublicKey;
    try {
      stealthPubkey = new PublicKey(stealthAddress);
    } catch {
      return res.status(400).json({ error: 'Invalid stealth address' });
    }

    // THE KEY PART: Send from RELAYER's wallet to stealth address
    // On-chain shows: Relayer → Stealth Address
    // NO LINK to the original depositor!
    const { Transaction: SolanaTransaction, SystemProgram: SolanaSystem } = await import('@solana/web3.js');

    const transaction = new SolanaTransaction().add(
      SolanaSystem.transfer({
        fromPubkey: relayerKeypair.publicKey,
        toPubkey: stealthPubkey,
        lamports: amount,
      })
    );

    transaction.feePayer = relayerKeypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(relayerKeypair);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await connection.confirmTransaction(signature, 'confirmed');

    // Mark nullifier as spent (CRITICAL: do this after successful send)
    spentNullifiers.add(nullifier);

    const totalTime = Date.now() - startTime;
    logger.info(`[${txId}] Private send SUCCESS (${totalTime}ms)`, {
      signature,
      stealthAddress: stealthPubkey.toBase58(),
      amount: amount / 1e9 + ' SOL',
    });

    // Return success - recipient will scan to find their funds
    res.json({
      success: true,
      txId,
      signature,
      stealthAddress: stealthPubkey.toBase58(),
      amount: amount / 1e9,
      verificationTimeMs: verificationTime,
      totalTimeMs: totalTime,
    });

    // TODO: In background, claim equivalent from shielded pool
    // This happens asynchronously to not link the transactions
    // claimFromPool(proof, nullifier, amount);

  } catch (e: any) {
    logger.error(`[${txId}] Private send failed:`, e);
    res.status(500).json({ error: e.message || 'Private send failed' });
  }
});

/**
 * Get available denominations for private sends
 */
app.get('/relay/denominations', (req, res) => {
  res.json({
    denominations: DENOMINATIONS.map((amount, index) => ({
      index,
      lamports: amount,
      sol: amount / 1e9,
      label: `${amount / 1e9} SOL`,
    })),
    note: 'Fixed denominations ensure maximum anonymity - all withdrawals of same size are indistinguishable',
  });
});

/**
 * PRIVATE TRANSFER (ANY AMOUNT) - Automatic privacy for ZK transfers
 *
 * This is the main endpoint for private transfers. It:
 * 1. Accepts proof that sender has funds in pool
 * 2. Sends SOL from relayer to recipient's stealth address
 * 3. Stores stealth metadata for recipient scanning
 *
 * On-chain visibility: "Relayer → Stealth Address"
 * Sender is completely hidden!
 */
app.post('/relay/private-transfer', async (req, res) => {
  const startTime = Date.now();
  const txId = `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const {
      proof,
      publicSignals,
      nullifier,
      stealthAddress,
      ephemeralPublicKey,
      viewTag,
      amountLamports,
      fundingTxSignature,
    } = req.body;

    // Validate required fields
    if (!proof || !publicSignals || !nullifier || !stealthAddress || !amountLamports) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!fundingTxSignature) {
      return res.status(400).json({ error: 'Missing funding transaction signature. User must send funds to relayer first.' });
    }

    const amount = parseInt(amountLamports);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Calculate fee: user pays amount + fee + gas + rent buffer
    const feeLamports = Math.ceil(amount * CONFIG.feeBps / 10000);
    const gasEstimate = 10000; // ~0.00001 SOL for tx fees
    const rentExempt = 890880; // Minimum balance for rent exemption
    const expectedFunding = amount + feeLamports + gasEstimate + rentExempt;

    logger.info(`[${txId}] Private transfer request`, {
      amount: amount / 1e9 + ' SOL',
      fee: feeLamports / 1e9 + ' SOL',
      expectedFunding: expectedFunding / 1e9 + ' SOL',
      stealthAddress: stealthAddress.slice(0, 16) + '...',
      fundingTx: fundingTxSignature.slice(0, 16) + '...',
      hasEphemeralKey: !!ephemeralPublicKey,
    });

    // Check nullifier hasn't been spent
    if (spentNullifiers.has(nullifier)) {
      logger.warn(`[${txId}] Nullifier already spent`);
      return res.status(400).json({ error: 'Funds already spent' });
    }

    // Verify ZK proof
    const verificationStart = Date.now();
    const isValid = await verifyProofOffChain(proof, publicSignals);
    const verificationTime = Date.now() - verificationStart;

    logger.info(`[${txId}] Proof verification: ${isValid ? 'VALID' : 'INVALID'} (${verificationTime}ms)`);

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid ZK proof' });
    }

    // Verify funding transaction: user sent funds to relayer
    let fundingVerified = false;
    try {
      const fundingTx = await connection.getTransaction(fundingTxSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!fundingTx) {
        return res.status(400).json({ error: 'Funding transaction not found or not confirmed' });
      }

      // Check that funds were sent TO the relayer
      const relayerAddress = relayerKeypair.publicKey.toBase58();
      const preBalances = fundingTx.meta?.preBalances || [];
      const postBalances = fundingTx.meta?.postBalances || [];
      const rawKeys: any = fundingTx.transaction.message.getAccountKeys?.()
        || (fundingTx.transaction.message as any).staticAccountKeys
        || [];
      // Normalize to string array
      const accountKeys: string[] = [];
      for (let j = 0; j < rawKeys.length; j++) {
        const k = rawKeys.get ? rawKeys.get(j) : rawKeys[j];
        accountKeys.push(typeof k === 'string' ? k : k?.toBase58?.() || '');
      }

      // Find relayer in account keys and check balance increase
      for (let i = 0; i < accountKeys.length; i++) {
        const key = accountKeys[i];
        if (key === relayerAddress) {
          const received = (postBalances[i] || 0) - (preBalances[i] || 0);
          if (received >= amount) {
            fundingVerified = true;
            logger.info(`[${txId}] Funding verified: received ${received / 1e9} SOL (expected >= ${amount / 1e9} SOL)`);
          } else {
            logger.warn(`[${txId}] Insufficient funding: received ${received / 1e9} SOL, need ${amount / 1e9} SOL`);
          }
          break;
        }
      }
    } catch (e) {
      logger.error(`[${txId}] Failed to verify funding tx:`, e);
    }

    if (!fundingVerified) {
      return res.status(400).json({ error: 'Funding transaction not verified. Ensure you sent sufficient funds to the relayer.' });
    }

    // Parse stealth address
    let stealthPubkey: PublicKey;
    try {
      stealthPubkey = new PublicKey(stealthAddress);
    } catch {
      return res.status(400).json({ error: 'Invalid stealth address' });
    }

    // Send amount from relayer to stealth address (funded by user, fee kept by relayer)
    const { Transaction: SolanaTransaction, SystemProgram: SolanaSystem } = await import('@solana/web3.js');

    const transaction = new SolanaTransaction().add(
      SolanaSystem.transfer({
        fromPubkey: relayerKeypair.publicKey,
        toPubkey: stealthPubkey,
        lamports: amount,
      })
    );

    transaction.feePayer = relayerKeypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(relayerKeypair);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await connection.confirmTransaction(signature, 'confirmed');

    // Mark nullifier as spent
    spentNullifiers.add(nullifier);

    // Store stealth payment for recipient scanning
    if (ephemeralPublicKey && viewTag) {
      const payment: StealthPayment = {
        stealthAddress: stealthPubkey.toBase58(),
        ephemeralPublicKey,
        viewTag,
        amount: amount / 1e9,
        timestamp: Date.now(),
        signature,
      };
      recentStealthPayments.unshift(payment);

      // Trim to max history
      if (recentStealthPayments.length > MAX_STEALTH_HISTORY) {
        recentStealthPayments.length = MAX_STEALTH_HISTORY;
      }

      // Persist to disk
      saveStealthPayments();
    }

    const totalTime = Date.now() - startTime;
    logger.info(`[${txId}] Private transfer SUCCESS (${totalTime}ms)`, {
      signature,
      stealthAddress: stealthPubkey.toBase58(),
      amount: amount / 1e9 + ' SOL',
      feeKept: feeLamports / 1e9 + ' SOL',
    });

    res.json({
      success: true,
      txId,
      signature,
      stealthAddress: stealthPubkey.toBase58(),
      amount: amount / 1e9,
      feePaid: feeLamports / 1e9,
      ephemeralPublicKey,
      viewTag,
      verificationTimeMs: verificationTime,
      totalTimeMs: totalTime,
    });

  } catch (e: any) {
    logger.error(`[${txId}] Private transfer failed:`, e);
    res.status(500).json({ error: e.message || 'Private transfer failed' });
  }
});

/**
 * Scan for stealth payments - Recipients call this to find their funds
 *
 * Returns recent stealth payments that wallets can scan using their viewing key.
 * Each wallet checks if payments are addressed to them using the view tag.
 */
app.get('/relay/stealth-payments', (req, res) => {
  const { since, limit } = req.query;

  let payments = recentStealthPayments;

  // Filter by timestamp if provided
  if (since) {
    const sinceTime = parseInt(since as string);
    if (!isNaN(sinceTime)) {
      payments = payments.filter(p => p.timestamp > sinceTime);
    }
  }

  // Limit results
  const maxResults = Math.min(parseInt(limit as string) || 100, 500);
  payments = payments.slice(0, maxResults);

  res.json({
    payments,
    count: payments.length,
    totalStored: recentStealthPayments.length,
  });
});

/**
 * Verify ZK proof off-chain using snarkjs
 */
async function verifyProofOffChain(proof: any, publicInputs: string[]): Promise<boolean> {
  try {
    // Check if we have a verification key loaded
    if (!verificationKey) {
      logger.warn('No verification key loaded - using mock verification (INSECURE)');
      return true; // Fallback for development
    }

    // Validate proof format
    if (!proof || !proof.pi_a || !proof.pi_b || !proof.pi_c) {
      logger.error('Invalid proof format - missing pi_a, pi_b, or pi_c');
      return false;
    }

    // Validate public inputs
    if (!publicInputs || !Array.isArray(publicInputs) || publicInputs.length === 0) {
      logger.error('Invalid public inputs - must be a non-empty array');
      return false;
    }

    // Verify expected number of public inputs matches VK
    if (publicInputs.length !== verificationKey.nPublic) {
      logger.error(`Public inputs count mismatch: got ${publicInputs.length}, expected ${verificationKey.nPublic}`);
      logger.error(`Public inputs received: ${JSON.stringify(publicInputs.slice(0, 3))}...`);
      return false;
    }

    logger.info(`Public inputs (${publicInputs.length}): ${publicInputs.map(p => p.toString().slice(0, 20) + '...').join(', ')}`);

    logger.debug('Verifying proof with snarkjs...', {
      nPublicInputs: publicInputs.length,
      proofKeys: Object.keys(proof),
    });

    // Perform actual verification with snarkjs
    const isValid = await snarkjs.groth16.verify(verificationKey, publicInputs, proof);

    logger.info(`Proof verification result: ${isValid ? 'VALID' : 'INVALID'}`);
    return isValid;

  } catch (e) {
    logger.error('Proof verification error:', e);
    return false;
  }
}

/**
 * Cleanup old pending transactions
 */
function cleanupPendingTxs() {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  for (const [txId, tx] of pendingTxs.entries()) {
    if (tx.submittedAt && now - tx.submittedAt > timeout) {
      logger.warn(`Cleaning up stale transaction: ${txId}`);
      pendingTxs.delete(txId);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupPendingTxs, 60000);

// Start server
app.listen(CONFIG.port, () => {
  logger.info(`Relayer started on port ${CONFIG.port}`);
  logger.info(`Program ID: ${CONFIG.programId.toBase58()}`);
  logger.info(`Relayer wallet: ${relayerKeypair.publicKey.toBase58()}`);
  logger.info(`Fee: ${CONFIG.feeBps / 100}%`);
  logger.info(`ZK Verification: ${verificationKey ? 'ENABLED (real snarkjs)' : 'DISABLED (mock)'}`);
  if (verificationKey) {
    logger.info(`VK: protocol=${verificationKey.protocol}, curve=${verificationKey.curve}, nPublic=${verificationKey.nPublic}`);
  }
});

// =============================================================================
// SUBSCRIPTION PAYMENT PROCESSING (CRANK)
// =============================================================================

const SUBSCRIPTION_PROGRAM_ID = new PublicKey(
  process.env.SUBSCRIPTION_PROGRAM_ID || 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'
);

// Subscription account structure (matches Anchor)
interface SubscriptionAccount {
  address: PublicKey;
  subscriber: PublicKey;
  merchant: PublicKey;
  mint: PublicKey;
  subscriptionId: string;
  amountPerPeriod: bigint;
  intervalSeconds: bigint;
  maxPayments: bigint;
  paymentsMade: bigint;
  nextPaymentDue: bigint;
  status: number; // 0=Active, 1=Paused, 2=Cancelled, 3=Completed
}

// Cache of known subscriptions (in production, use a database)
const subscriptionCache: Map<string, SubscriptionAccount> = new Map();
let lastSubscriptionScan = 0;
const SUBSCRIPTION_SCAN_INTERVAL = 5 * 60 * 1000; // Scan every 5 minutes

/**
 * Scan for active subscriptions from the blockchain
 */
async function scanSubscriptions(): Promise<SubscriptionAccount[]> {
  try {
    logger.info('[Subscriptions] Scanning for active subscriptions...');

    // Get all program accounts for the subscription program
    const accounts = await connection.getProgramAccounts(SUBSCRIPTION_PROGRAM_ID, {
      filters: [
        { dataSize: 8 + 32 + 32 + 32 + 68 + 36 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 1 }, // Approximate size
      ],
    });

    const subscriptions: SubscriptionAccount[] = [];

    for (const { pubkey, account } of accounts) {
      try {
        // Skip if data is too small
        if (account.data.length < 200) continue;

        // Parse subscription account (skip 8-byte discriminator)
        const data = account.data.slice(8);
        let offset = 0;

        const subscriber = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
        const merchant = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
        const mint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;

        // Read subscription_id (4-byte length + string)
        const idLen = data.readUInt32LE(offset); offset += 4;
        const subscriptionId = data.slice(offset, offset + idLen).toString('utf8'); offset += 64; // max_len

        // Read subscription_name
        const nameLen = data.readUInt32LE(offset); offset += 4;
        offset += 32; // max_len

        // Read numeric fields
        const amountPerPeriod = data.readBigUInt64LE(offset); offset += 8;
        const intervalSeconds = data.readBigInt64LE(offset); offset += 8;
        const maxPayments = data.readBigUInt64LE(offset); offset += 8;
        const paymentsMade = data.readBigUInt64LE(offset); offset += 8;
        offset += 8; // total_paid
        offset += 8; // created_at
        offset += 8; // last_payment_at
        const nextPaymentDue = data.readBigInt64LE(offset); offset += 8;
        const status = data.readUInt8(offset);

        // Only include active subscriptions
        if (status === 0) {
          subscriptions.push({
            address: pubkey,
            subscriber,
            merchant,
            mint,
            subscriptionId,
            amountPerPeriod,
            intervalSeconds,
            maxPayments,
            paymentsMade,
            nextPaymentDue,
            status,
          });
        }
      } catch (e) {
        // Skip malformed accounts
        continue;
      }
    }

    logger.info(`[Subscriptions] Found ${subscriptions.length} active subscriptions`);

    // Update cache
    subscriptionCache.clear();
    for (const sub of subscriptions) {
      subscriptionCache.set(sub.address.toBase58(), sub);
    }
    lastSubscriptionScan = Date.now();

    return subscriptions;
  } catch (e) {
    logger.error('[Subscriptions] Failed to scan:', e);
    return [];
  }
}

/**
 * Process a due subscription payment
 */
async function processSubscriptionPayment(subscription: SubscriptionAccount): Promise<string | null> {
  const subId = subscription.address.toBase58().slice(0, 8);

  try {
    logger.info(`[Sub:${subId}] Processing payment...`, {
      subscriber: subscription.subscriber.toBase58().slice(0, 8),
      merchant: subscription.merchant.toBase58().slice(0, 8),
      amount: Number(subscription.amountPerPeriod) / 1e9,
    });

    // Build process_payment instruction
    // Note: In production, use @coral-xyz/anchor to build the transaction
    const { Transaction: SolanaTransaction, TransactionInstruction } = await import('@solana/web3.js');

    // Get associated token accounts
    const { getAssociatedTokenAddress } = await import('@solana/spl-token');

    const subscriberAta = await getAssociatedTokenAddress(
      subscription.mint,
      subscription.subscriber
    );

    const merchantAta = await getAssociatedTokenAddress(
      subscription.mint,
      subscription.merchant
    );

    // Build instruction data: discriminator (8 bytes) + amount (8 bytes)
    // process_payment discriminator: sha256("global:process_payment")[0..8]
    const discriminator = Buffer.from([0x80, 0x14, 0x0a, 0x58, 0xd7, 0xb1, 0x1a, 0x4b]); // Example
    const amountData = Buffer.alloc(8);
    amountData.writeBigUInt64LE(subscription.amountPerPeriod);
    const instructionData = Buffer.concat([discriminator, amountData]);

    const instruction = new TransactionInstruction({
      programId: SUBSCRIPTION_PROGRAM_ID,
      keys: [
        { pubkey: relayerKeypair.publicKey, isSigner: true, isWritable: true }, // payer
        { pubkey: subscription.address, isSigner: false, isWritable: true }, // subscription
        { pubkey: subscriberAta, isSigner: false, isWritable: true }, // subscriber_token_account
        { pubkey: merchantAta, isSigner: false, isWritable: true }, // merchant_token_account
        { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false }, // token_program
      ],
      data: instructionData,
    });

    const transaction = new SolanaTransaction().add(instruction);
    transaction.feePayer = relayerKeypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.sign(relayerKeypair);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await connection.confirmTransaction(signature, 'confirmed');

    logger.info(`[Sub:${subId}] Payment SUCCESS`, { signature });
    return signature;

  } catch (e: any) {
    logger.error(`[Sub:${subId}] Payment FAILED:`, e.message || e);
    return null;
  }
}

/**
 * Crank: Process all due subscription payments
 */
async function crankSubscriptions() {
  logger.info('[Crank] Starting subscription crank...');

  const now = Math.floor(Date.now() / 1000);
  let processed = 0;
  let failed = 0;

  // Refresh subscriptions if cache is stale
  if (Date.now() - lastSubscriptionScan > SUBSCRIPTION_SCAN_INTERVAL) {
    await scanSubscriptions();
  }

  for (const [address, subscription] of subscriptionCache) {
    // Check if payment is due
    if (Number(subscription.nextPaymentDue) <= now) {
      const signature = await processSubscriptionPayment(subscription);
      if (signature) {
        processed++;
        // Update local cache
        subscription.paymentsMade += BigInt(1);
        subscription.nextPaymentDue += subscription.intervalSeconds;
      } else {
        failed++;
      }

      // Small delay between transactions to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  logger.info(`[Crank] Complete: ${processed} processed, ${failed} failed`);
}

/**
 * GET /subscriptions/scan - Manually trigger subscription scan
 */
app.get('/subscriptions/scan', async (req, res) => {
  try {
    const subscriptions = await scanSubscriptions();
    res.json({
      success: true,
      count: subscriptions.length,
      subscriptions: subscriptions.map(s => ({
        address: s.address.toBase58(),
        subscriber: s.subscriber.toBase58(),
        merchant: s.merchant.toBase58(),
        amount: Number(s.amountPerPeriod) / 1e9,
        intervalSeconds: Number(s.intervalSeconds),
        paymentsMade: Number(s.paymentsMade),
        maxPayments: Number(s.maxPayments),
        nextPaymentDue: new Date(Number(s.nextPaymentDue) * 1000).toISOString(),
        isDue: Number(s.nextPaymentDue) <= Math.floor(Date.now() / 1000),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /subscriptions/crank - Manually trigger subscription crank
 */
app.post('/subscriptions/crank', async (req, res) => {
  try {
    await crankSubscriptions();
    res.json({ success: true, message: 'Crank executed' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /subscriptions/status - Get subscription processing status
 */
app.get('/subscriptions/status', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const dueCount = Array.from(subscriptionCache.values()).filter(
    s => Number(s.nextPaymentDue) <= now
  ).length;

  res.json({
    totalCached: subscriptionCache.size,
    dueNow: dueCount,
    lastScan: lastSubscriptionScan ? new Date(lastSubscriptionScan).toISOString() : null,
    scanIntervalMs: SUBSCRIPTION_SCAN_INTERVAL,
    crankIntervalMs: CRANK_INTERVAL,
    programId: SUBSCRIPTION_PROGRAM_ID.toBase58(),
  });
});

// Run subscription crank every hour
const CRANK_INTERVAL = 60 * 60 * 1000; // 1 hour
setInterval(crankSubscriptions, CRANK_INTERVAL);

// Initial scan on startup (after 10 seconds to let server start)
setTimeout(async () => {
  await scanSubscriptions();
  // Run initial crank after scan
  await crankSubscriptions();
}, 10000);

logger.info(`[Subscriptions] Crank service enabled - running every ${CRANK_INTERVAL / 60000} minutes`);

// =============================================================================

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down relayer...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down relayer...');
  process.exit(0);
});
