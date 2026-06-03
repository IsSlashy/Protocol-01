/**
 * DenominatedImport — import a received shareable note into the local wallet.
 *
 * Paste the encoded note string handed off by a sender (from DenominatedTransfer).
 * Decodes + previews the token/denomination/pool, then imports it into the
 * denominated pool store. After import the note can be unshielded like any other
 * (the recipient does NOT need to wait for maturity on unshield).
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Download,
  CheckCircle,
  Loader2,
  AlertTriangle,
  Copy,
  Check,
  Lock,
} from 'lucide-react';
import { cn, copyToClipboard } from '@/shared/utils';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { ALL_POOLS_V3 } from '@/shared/services/denominatedPool';

export default function DenominatedImport() {
  const navigate = useNavigate();
  const { importNoteAction, peekNote, getMyNoteAddress, loading } = useDenominatedPoolStore();

  const [encoded, setEncoded] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);

  // This wallet's own receive address — share it to receive private notes.
  const myAddress = useMemo(() => {
    try {
      return getMyNoteAddress();
    } catch {
      return null; // e.g. wallet locked (no local keypair available)
    }
  }, [getMyNoteAddress]);

  // Live preview of the pasted note (decrypts p01enc1 blobs with this wallet).
  const preview = useMemo(() => {
    const trimmed = encoded.trim();
    if (!trimmed) return null;
    try {
      const note = peekNote(trimmed);
      const known = ALL_POOLS_V3.some((p) => p.poolPDA.toBase58() === note.pool);
      return {
        token: note.token,
        denominationHuman: note.denominationHuman,
        pool: note.pool,
        known,
      };
    } catch {
      return { invalid: true as const };
    }
  }, [encoded, peekNote]);

  const handleCopyAddress = async () => {
    if (!myAddress) return;
    await copyToClipboard(myAddress);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  const canImport =
    !!preview && !('invalid' in preview) && preview.known && !loading;

  const handleImport = async () => {
    setError(null);
    try {
      await importNoteAction({ encoded: encoded.trim() });
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (done) {
    return (
      <div className="flex flex-col h-full bg-p01-void">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
          <button
            onClick={() => navigate(-1)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 text-center">
            <h1 className="text-white font-display font-bold tracking-wide text-sm">IMPORT NOTE</h1>
            <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
              PRIVATE DENOMINATED POOL
            </p>
          </div>
          <div className="w-9" />
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-4 pt-8"
          >
            <CheckCircle className="w-16 h-16 text-p01-cyan" />
            <p className="text-white font-display font-bold text-lg tracking-wide">Note Imported!</p>
            <p className="text-p01-chrome text-xs text-center">
              The note is now in your shielded funds. You can unshield it any time.
            </p>
            <button
              onClick={() => navigate(-1)}
              className="mt-4 px-6 py-2 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider"
            >
              Done
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-p01-void">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-white font-display font-bold tracking-wide text-sm">IMPORT NOTE</h1>
          <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
            PRIVATE DENOMINATED POOL
          </p>
        </div>
        <div className="w-9" />
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Your receive address — share to receive private notes */}
        <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Lock className="w-3 h-3 text-p01-cyan" />
              <span className="text-p01-chrome text-[10px] font-mono tracking-wider">
                YOUR RECEIVE ADDRESS (share to receive)
              </span>
            </div>
            {myAddress && (
              <button
                onClick={handleCopyAddress}
                className="flex items-center gap-1 text-p01-cyan text-[10px] hover:text-p01-cyan/80 transition-colors"
                aria-label={addrCopied ? 'Address copied' : 'Copy your receive address'}
              >
                {addrCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {addrCopied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          {myAddress ? (
            <p className="text-p01-chrome/70 text-[9px] font-mono break-all leading-relaxed max-h-16 overflow-y-auto">
              {myAddress}
            </p>
          ) : (
            <p className="text-p01-red text-[9px] font-mono">
              Unavailable — a local wallet key is required to derive your receive address.
            </p>
          )}
          <p className="text-p01-chrome/40 text-[8px] mt-1.5 leading-relaxed">
            Public key material (X25519 + ML-KEM-768) — safe to share. Senders encrypt notes to it;
            only your wallet can open them.
          </p>
        </div>

        <div>
          <p className="text-p01-chrome text-[10px] font-mono mb-2">PASTE RECEIVED NOTE</p>
          <textarea
            value={encoded}
            onChange={(e) => {
              setEncoded(e.target.value);
              setError(null);
            }}
            placeholder="Paste the p01enc1:… encrypted note from the sender..."
            rows={5}
            aria-label="Encrypted note"
            className="w-full bg-p01-surface border border-p01-border rounded-xl p-3 text-white text-[10px] font-mono outline-none focus:border-p01-cyan/40 placeholder:text-p01-chrome/30 resize-none break-all"
          />
        </div>

        {/* Preview */}
        {preview && 'invalid' in preview && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-p01-red/10 border border-p01-red/30">
            <AlertTriangle className="w-4 h-4 text-p01-red shrink-0 mt-0.5" />
            <p className="text-p01-red text-[10px] font-mono">
              Can&apos;t read this note. Either the string is incomplete, or it was encrypted to a
              different wallet (only the intended recipient can open it).
            </p>
          </div>
        )}
        {preview && !('invalid' in preview) && (
          <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-p01-chrome text-[10px]">Amount</span>
              <span className="text-white text-sm font-mono font-bold">
                {preview.denominationHuman} {preview.token}
              </span>
            </div>
            <p className="text-p01-chrome/40 text-[9px] font-mono truncate">
              pool {preview.pool.slice(0, 12)}…
            </p>
            {!preview.known && (
              <p className="text-p01-red text-[9px] font-mono mt-1">
                Unknown pool — this note is not from a recognised V3 pool.
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30" role="alert" aria-live="assertive">
            <p className="text-p01-red text-[10px] font-mono break-all">{error}</p>
          </div>
        )}

        <button
          onClick={handleImport}
          disabled={!canImport}
          className={cn(
            'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
            !canImport
              ? 'bg-p01-surface border border-p01-border text-p01-chrome/50 cursor-not-allowed'
              : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90',
          )}
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Importing...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Import Note
            </>
          )}
        </button>
      </div>
    </div>
  );
}
