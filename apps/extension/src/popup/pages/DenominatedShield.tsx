/**
 * DenominatedShield — create a shielded denominated note.
 *
 * Lets the user pick a token (SOL/USDC) and denomination, then shields
 * the fixed amount into the corresponding V3 Goldilocks pool via
 * circuit 6 (merkle_update) STARK proof. The resulting ShieldReceipt is
 * stored in the denominated pool store and can be used to fund a shielded
 * subscription.
 *
 * WHAT THE DEPOSIT PUBLISHES. The user's own wallet is the depositor and the
 * fee payer (shared/services/denominatedPool.ts shieldV3 passes
 * `signer.publicKey` to buildShieldDenominatedV3Ix), and the note commitment
 * travels in the same instruction. So the deposit is a public, wallet-attributed
 * transaction. What the pool buys is that the note's OWNER is not on-chain
 * afterwards — not that the deposit is unattributable.
 *
 * The withdrawal republishes this same commitment (it is `stark_commitment`,
 * ix data byte 80, of unshield_denominated_stark_v3), so deposit and withdrawal
 * are matchable to each other by anyone. Confirmed on devnet: leaf 16,
 * commitment 8901821612542787864, present in both the deposit and the
 * withdrawal transaction. Closing that needs the C7 spend circuit
 * (docs/C7_SPEND_CIRCUIT_PLAN.md), which is not built.
 *
 * Proof generation (C6) takes 30-60s in the browser extension WASM.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Lock, Loader2, CheckCircle } from 'lucide-react';
import { cn } from '@/shared/utils';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { getPoolsForTokenV3 } from '@/shared/services/denominatedPool';

type TokenType = 'SOL' | 'USDC';

export default function DenominatedShield() {
  const navigate = useNavigate();
  const { shieldNote, loading } = useDenominatedPoolStore();

  const [token, setToken] = useState<TokenType>('SOL');
  const [denomination, setDenomination] = useState<number | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);

  // Fixed denominations only (like the mobile app) — never free-form amounts.
  // SOL: 0.1 / 1 / 10 / 100 / 1000 (the 500 pool exists on-chain but is hidden
  // to keep the standard ladder).
  const ALLOWED_SOL = [0.1, 1, 10, 100, 1000];
  const pools = getPoolsForTokenV3(token).filter(
    (p) => token !== 'SOL' || ALLOWED_SOL.includes(p.denomination),
  );

  const handleCreate = async () => {
    if (denomination === null) return;
    setError(null);
    setProgress('Starting...');
    try {
      const result = await shieldNote({
        token,
        denomination,
        onProgress: (step) => setProgress(step),
      });
      setTxSig(result.txSig);
      setDone(true);
      setProgress(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 text-p01-chrome hover:text-p01-text transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-p01-text font-display font-bold tracking-wide text-sm">
            SHIELD
          </h1>
          <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
            SHIELDED DENOMINATED POOL
          </p>
        </div>
        <div className="w-9" />
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {done ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-4 pt-8"
          >
            <CheckCircle className="w-16 h-16 text-p01-cyan" />
            <p className="text-p01-text font-display font-bold text-lg tracking-wide">
              Note created!
            </p>
            <p className="text-p01-chrome text-xs text-center">
              {denomination} {token} shielded into the Goldilocks pool. Your wallet
              signed this deposit and the note commitment is in the same transaction,
              so the deposit itself is public. From here on the note has no on-chain
              owner — but withdrawing it republishes this commitment, which matches
              it back to this deposit.
            </p>
            {txSig && (
              <p className="text-p01-chrome/50 text-[9px] font-mono break-all text-center">
                tx: {txSig}
              </p>
            )}
            <button
              onClick={() => navigate(-1)}
              className="mt-4 px-6 py-2 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider"
            >
              Done
            </button>
          </motion.div>
        ) : (
          <>
            {/* Token toggle */}
            <div>
              <p className="text-p01-chrome text-[10px] font-mono mb-2">TOKEN</p>
              <div className="flex gap-2">
                {(['SOL', 'USDC'] as TokenType[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => { setToken(t); setDenomination(null); }}
                    className={cn(
                      'flex-1 py-2 rounded-xl border text-sm font-display font-bold tracking-wide transition-all',
                      token === t
                        ? 'bg-p01-cyan/15 border-p01-cyan text-p01-cyan'
                        : 'bg-p01-surface border-p01-border text-p01-chrome hover:border-p01-cyan/40',
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Denomination picker */}
            <div>
              <p className="text-p01-chrome text-[10px] font-mono mb-2">DENOMINATION</p>
              <div className="grid grid-cols-3 gap-2">
                {pools.map((pool) => (
                  <button
                    key={pool.denomination}
                    onClick={() => setDenomination(pool.denomination)}
                    className={cn(
                      'py-3 rounded-xl border text-sm font-mono font-bold transition-all',
                      denomination === pool.denomination
                        ? 'bg-p01-cyan/15 border-p01-cyan text-p01-cyan'
                        : 'bg-p01-surface border-p01-border text-p01-text hover:border-p01-cyan/40',
                    )}
                  >
                    {pool.denomination}
                  </button>
                ))}
              </div>
            </div>

            {/* Info card */}
            <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15">
              <div className="flex items-start gap-2">
                <Lock className="w-4 h-4 text-p01-cyan shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-p01-text text-xs font-medium">
                    ZK Denominated Shield (C6)
                  </p>
                  <p className="text-p01-chrome text-[10px]">
                    Shields exactly {denomination ?? '?'} {token} into a Goldilocks
                    Poseidon pool — fixed denominations only, so deposits are
                    indistinguishable. Proof generation takes 30-60s.
                  </p>
                </div>
              </div>
            </div>

            {/* Progress / error */}
            {progress && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-p01-surface border border-p01-border">
                <Loader2 className="w-4 h-4 text-p01-cyan animate-spin shrink-0" />
                <p className="text-p01-chrome text-[10px] font-mono">{progress}</p>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30">
                <p className="text-p01-red text-[10px] font-mono break-all">{error}</p>
              </div>
            )}

            {/* Action button */}
            <button
              onClick={handleCreate}
              disabled={denomination === null || loading || !!progress}
              className={cn(
                'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
                denomination === null || loading || !!progress
                  ? 'bg-p01-surface border border-p01-border text-p01-chrome/50 cursor-not-allowed'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90',
              )}
            >
              {loading || !!progress ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Proving...
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  Create Shielded Note
                </>
              )}
            </button>

            <p className="text-p01-chrome/40 text-[9px] font-mono text-center">
              C6 proof + on-chain shield takes ~60s. Keep popup open.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
