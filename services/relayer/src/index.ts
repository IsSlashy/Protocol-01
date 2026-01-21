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
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import * as snarkjs from 'snarkjs';
import winston from 'winston';
import dotenv from 'dotenv';

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
  programId: new PublicKey(process.env.ZK_PROGRAM_ID || 'ZkShLdPooooooooooooooooooooooooooooooooooooo'),
  feeRecipient: process.env.FEE_RECIPIENT_PUBKEY,
  feeBps: parseInt(process.env.FEE_BPS || '10'), // 0.1% default
  maxPendingTx: parseInt(process.env.MAX_PENDING_TX || '100'),
};

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
let relayerKeypair: Keypair;
try {
  const secretKey = process.env.RELAYER_SECRET_KEY;
  if (secretKey) {
    relayerKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(secretKey))
    );
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
app.use(express.json({ limit: '1mb' }));

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    relayer: relayerKeypair.publicKey.toBase58(),
    pendingTxs: pendingTxs.size,
    feeBps: CONFIG.feeBps,
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
    });
  } catch (e) {
    logger.error('Failed to get relayer info:', e);
    res.status(500).json({ error: 'Internal server error' });
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

/**
 * Verify ZK proof off-chain using snarkjs
 */
async function verifyProofOffChain(proof: any, publicInputs: string[]): Promise<boolean> {
  try {
    // Load verification key (in production, load from file)
    const vkPath = process.env.VERIFICATION_KEY_PATH || './build/verification_key.json';

    // For now, return true (mock verification)
    // In production:
    // const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));
    // return snarkjs.groth16.verify(vk, publicInputs, proof);

    logger.debug('Mock verification - returning true');
    return true;
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
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down relayer...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down relayer...');
  process.exit(0);
});
