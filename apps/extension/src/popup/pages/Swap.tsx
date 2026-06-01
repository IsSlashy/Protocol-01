import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUpDown,
  Settings,
  ChevronDown,
  Search,
  ExternalLink,
  Check,
  X,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import {
  getQuote,
  getSwapTransaction,
  executeSwap,
  getPopularTokens,
  formatTokenAmount,
  parseTokenAmount,
  getPriceImpactSeverity,
  TOKEN_MINTS,
  type JupiterToken,
  type QuoteResponse,
} from '../../shared/services/jupiter';
import { useWalletStore } from '../../shared/store/wallet';
import { getConnection } from '../../shared/services/wallet';
import { VersionedTransaction } from '@solana/web3.js';

type SwapStatus = 'idle' | 'quoting' | 'signing' | 'swapping' | 'success' | 'error';

const FALLBACK_SOL: JupiterToken = {
  address: TOKEN_MINTS.SOL,
  chainId: 101,
  decimals: 9,
  name: 'Solana',
  symbol: 'SOL',
  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
};

const FALLBACK_USDC: JupiterToken = {
  address: TOKEN_MINTS.USDC,
  chainId: 101,
  decimals: 6,
  name: 'USD Coin',
  symbol: 'USDC',
  logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
};

const SLIPPAGE_OPTIONS = [
  { label: '0.5%', bps: 50 },
  { label: '1%', bps: 100 },
  { label: '2%', bps: 200 },
];

export default function Swap() {
  const navigate = useNavigate();
  const { publicKey, solBalance, network, _keypair } = useWalletStore();

  const [inputToken, setInputToken] = useState<JupiterToken>(FALLBACK_SOL);
  const [outputToken, setOutputToken] = useState<JupiterToken>(FALLBACK_USDC);
  const [inputAmount, setInputAmount] = useState('');
  const [outputAmount, setOutputAmount] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [status, setStatus] = useState<SwapStatus>('idle');
  const [slippageBps, setSlippageBps] = useState(50);
  const [showSlippage, setShowSlippage] = useState(false);
  const [showTokenSelector, setShowTokenSelector] = useState<'input' | 'output' | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successSig, setSuccessSig] = useState('');
  const [popularTokens, setPopularTokens] = useState<JupiterToken[]>([]);
  const [tokenSearch, setTokenSearch] = useState('');
  const [showQuoteDetails, setShowQuoteDetails] = useState(false);

  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDevnet = network === 'devnet';

  // Load popular tokens
  useEffect(() => {
    getPopularTokens().then(setPopularTokens);
  }, []);

  // Debounced quote fetch
  useEffect(() => {
    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);

    if (!inputAmount || parseFloat(inputAmount) <= 0 || isDevnet) {
      setOutputAmount('');
      setQuote(null);
      return;
    }

    setStatus('quoting');
    quoteTimerRef.current = setTimeout(async () => {
      try {
        const amountRaw = parseTokenAmount(inputAmount, inputToken.decimals).toString();
        const q = await getQuote({
          inputMint: inputToken.address,
          outputMint: outputToken.address,
          amount: amountRaw,
          slippageBps,
        });
        setQuote(q);
        setOutputAmount(formatTokenAmount(q.outAmount, outputToken.decimals));
        setStatus('idle');
      } catch (e: any) {
        setOutputAmount('');
        setQuote(null);
        setStatus('idle');
      }
    }, 500);

    return () => {
      if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    };
  }, [inputAmount, inputToken.address, outputToken.address, slippageBps, isDevnet]);

  const handleFlip = () => {
    const tmp = inputToken;
    setInputToken(outputToken);
    setOutputToken(tmp);
    setInputAmount('');
    setOutputAmount('');
    setQuote(null);
  };

  const handleMax = () => {
    if (inputToken.address === TOKEN_MINTS.SOL) {
      const max = Math.max(0, solBalance - 0.01);
      setInputAmount(max > 0 ? max.toFixed(6) : '0');
    }
  };

  const handleSwap = async () => {
    if (!quote || !publicKey) return;
    setErrorMessage('');

    try {
      setStatus('signing');
      const swapRes = await getSwapTransaction({
        quoteResponse: quote,
        userPublicKey: publicKey,
      });

      setStatus('swapping');
      const connection = getConnection(network);

      const signTransaction = async (tx: VersionedTransaction) => {
        if (_keypair) {
          tx.sign([_keypair]);
          return tx;
        }
        throw new Error('Wallet not unlocked');
      };

      const sig = await executeSwap({
        connection,
        swapTransaction: swapRes.swapTransaction,
        signTransaction,
      });

      setSuccessSig(sig);
      setStatus('success');

      // Refresh balance
      useWalletStore.getState().refreshBalance();
    } catch (e: any) {
      setErrorMessage(e.message || 'Swap failed');
      setStatus('error');
    }
  };

  const resetSwap = () => {
    setStatus('idle');
    setErrorMessage('');
    setSuccessSig('');
    setInputAmount('');
    setOutputAmount('');
    setQuote(null);
  };

  const filteredTokens = popularTokens.filter(t => {
    if (!tokenSearch) return true;
    const q = tokenSearch.toLowerCase();
    return t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
  });

  const impactSeverity = quote ? getPriceImpactSeverity(quote.priceImpactPct) : 'low';
  const impactColor = impactSeverity === 'low' ? 'text-p01-cyan' : impactSeverity === 'medium' ? 'text-warning' : 'text-error';

  const getButtonText = () => {
    if (isDevnet) return 'Swap unavailable on devnet';
    if (!publicKey) return 'Connect wallet';
    if (!inputAmount || parseFloat(inputAmount) <= 0) return 'Enter an amount';
    if (status === 'quoting') return 'Fetching quote...';
    if (status === 'signing') return 'Sign transaction...';
    if (status === 'swapping') return 'Swapping...';
    if (!quote) return 'Enter an amount';
    return 'Swap';
  };

  const canSwap = !!quote && !!publicKey && status === 'idle' && !isDevnet && parseFloat(inputAmount) > 0;

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-p01-border">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 hover:bg-p01-surface rounded-lg transition-colors" aria-label="Go back">
            <ArrowLeft className="w-5 h-5 text-p01-chrome" />
          </button>
          <h1 className="text-lg font-semibold text-white">Swap</h1>
        </div>
        <button onClick={() => setShowSlippage(!showSlippage)} className="p-2 hover:bg-p01-surface rounded-lg transition-colors" aria-label="Slippage settings" aria-expanded={showSlippage}>
          <Settings className="w-5 h-5 text-p01-chrome" />
        </button>
      </div>

      {/* Slippage dropdown */}
      <AnimatePresence>
        {showSlippage && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-p01-border"
          >
            <div className="p-3 flex items-center gap-2">
              <span className="text-xs text-p01-chrome">Slippage:</span>
              {SLIPPAGE_OPTIONS.map(opt => (
                <button
                  key={opt.bps}
                  onClick={() => setSlippageBps(opt.bps)}
                  aria-pressed={slippageBps === opt.bps}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    slippageBps === opt.bps
                      ? 'bg-p01-cyan text-p01-void'
                      : 'bg-p01-surface text-p01-chrome hover:bg-p01-elevated'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Devnet warning */}
      {isDevnet && (
        <div className="mx-4 mt-3 p-2.5 bg-yellow-500/10 border border-yellow-500/30 rounded-xl flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
          <span className="text-xs text-yellow-300">Swap is only available on mainnet</span>
        </div>
      )}

      {/* Swap body */}
      <div className="flex-1 p-4 space-y-2 overflow-y-auto">
        {/* You Pay */}
        <div className="bg-p01-surface rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-p01-chrome">You Pay</span>
            {inputToken.address === TOKEN_MINTS.SOL && (
              <button onClick={handleMax} className="text-xs text-p01-cyan hover:underline">
                MAX
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={inputAmount}
              onChange={e => {
                const v = e.target.value.replace(/[^0-9.]/g, '');
                if (v.split('.').length <= 2) setInputAmount(v);
              }}
              aria-label="Amount to swap"
              className="flex-1 bg-transparent text-2xl font-semibold text-white outline-none placeholder-p01-chrome/40 min-w-0"
            />
            <TokenButton token={inputToken} onClick={() => setShowTokenSelector('input')} />
          </div>
        </div>

        {/* Flip */}
        <div className="flex justify-center -my-1 relative z-10">
          <button
            onClick={handleFlip}
            className="w-10 h-10 rounded-full bg-p01-elevated border-2 border-p01-border flex items-center justify-center hover:bg-p01-surface transition-colors"
            aria-label="Swap input and output tokens"
          >
            <ArrowUpDown className="w-4 h-4 text-p01-cyan" />
          </button>
        </div>

        {/* You Receive */}
        <div className="bg-p01-surface rounded-2xl p-4">
          <span className="text-xs text-p01-chrome mb-2 block">You Receive</span>
          <div className="flex items-center gap-3">
            <div className="flex-1 text-2xl font-semibold text-white min-w-0 truncate">
              {status === 'quoting' ? (
                <Loader2 className="w-5 h-5 animate-spin text-p01-chrome inline" />
              ) : (
                outputAmount || <span className="text-p01-chrome/40">0</span>
              )}
            </div>
            <TokenButton token={outputToken} onClick={() => setShowTokenSelector('output')} />
          </div>
        </div>

        {/* Quote details */}
        {quote && (
          <button onClick={() => setShowQuoteDetails(!showQuoteDetails)} className="w-full text-left">
            <div className="bg-p01-surface/50 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-p01-chrome">
                  1 {inputToken.symbol} = {(parseFloat(formatTokenAmount(quote.outAmount, outputToken.decimals)) / parseFloat(formatTokenAmount(quote.inAmount, inputToken.decimals))).toFixed(4)} {outputToken.symbol}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-p01-chrome transition-transform ${showQuoteDetails ? 'rotate-180' : ''}`} />
              </div>
              <AnimatePresence>
                {showQuoteDetails && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 pt-2 border-t border-p01-border space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-p01-chrome">Price Impact</span>
                        <span className={impactColor}>{parseFloat(quote.priceImpactPct).toFixed(2)}%</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-p01-chrome">Min Received</span>
                        <span className="text-white">{formatTokenAmount(quote.otherAmountThreshold, outputToken.decimals)} {outputToken.symbol}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-p01-chrome">Route</span>
                        <span className="text-white">{quote.routePlan.map(r => r.swapInfo.label).join(' → ')}</span>
                      </div>
                      {quote.platformFee && (
                        <div className="flex justify-between text-xs">
                          <span className="text-p01-chrome">Platform Fee</span>
                          <span className="text-white">{formatTokenAmount(quote.platformFee.amount, outputToken.decimals)} {outputToken.symbol}</span>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </button>
        )}
      </div>

      {/* Swap button */}
      <div className="p-4 border-t border-p01-border">
        <button
          onClick={handleSwap}
          disabled={!canSwap}
          className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
            canSwap
              ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
              : 'bg-p01-surface text-p01-chrome/50 cursor-not-allowed'
          }`}
        >
          {(status === 'quoting' || status === 'signing' || status === 'swapping') && (
            <Loader2 className="w-4 h-4 animate-spin" />
          )}
          {getButtonText()}
        </button>
      </div>

      {/* Success overlay */}
      <AnimatePresence>
        {status === 'success' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-p01-void/95 flex flex-col items-center justify-center p-6 z-50"
          >
            <div className="w-16 h-16 rounded-full bg-p01-cyan/20 flex items-center justify-center mb-4">
              <Check className="w-8 h-8 text-p01-cyan" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Swap Successful</h2>
            <p className="text-p01-chrome text-sm text-center mb-1">
              {inputAmount} {inputToken.symbol} → {outputAmount} {outputToken.symbol}
            </p>
            {successSig && (
              <a
                href={`https://solscan.io/tx/${successSig}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-p01-cyan flex items-center gap-1 mt-2 hover:underline"
              >
                View on Solscan <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <button onClick={resetSwap} className="mt-6 px-8 py-3 bg-p01-cyan text-p01-void font-semibold rounded-xl">
              Done
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error overlay */}
      <AnimatePresence>
        {status === 'error' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-p01-void/95 flex flex-col items-center justify-center p-6 z-50"
          >
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
              <X className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Swap Failed</h2>
            <p className="text-red-300 text-sm text-center mb-4 max-w-[280px]">{errorMessage}</p>
            <div className="flex gap-3">
              <button onClick={resetSwap} className="px-6 py-2.5 bg-p01-surface text-white font-medium rounded-xl">
                Cancel
              </button>
              <button onClick={() => { setStatus('idle'); setErrorMessage(''); handleSwap(); }} className="px-6 py-2.5 bg-p01-cyan text-p01-void font-medium rounded-xl">
                Retry
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Token selector overlay */}
      <AnimatePresence>
        {showTokenSelector && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute inset-0 bg-p01-void flex flex-col z-50"
          >
            <div className="flex items-center gap-3 p-4 border-b border-p01-border">
              <button onClick={() => { setShowTokenSelector(null); setTokenSearch(''); }} className="p-2 -ml-2 hover:bg-p01-surface rounded-lg" aria-label="Close token selector">
                <ArrowLeft className="w-5 h-5 text-p01-chrome" />
              </button>
              <h2 className="text-lg font-semibold text-white">Select Token</h2>
            </div>
            <div className="p-4">
              <div className="relative">
                <Search className="w-4 h-4 text-p01-chrome absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search tokens..."
                  value={tokenSearch}
                  onChange={e => setTokenSearch(e.target.value)}
                  aria-label="Search tokens"
                  className="w-full bg-p01-surface rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-p01-chrome/50 outline-none border border-p01-border focus:border-p01-cyan/50"
                  autoFocus
                />
              </div>
            </div>
            {/* Popular tokens grid */}
            <div className="px-4 pb-2 flex flex-wrap gap-2">
              {popularTokens.slice(0, 6).map(t => (
                <button
                  key={t.address}
                  onClick={() => {
                    if (showTokenSelector === 'input') setInputToken(t);
                    else setOutputToken(t);
                    setShowTokenSelector(null);
                    setTokenSearch('');
                    setInputAmount('');
                    setOutputAmount('');
                    setQuote(null);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-p01-surface rounded-full hover:bg-p01-elevated transition-colors"
                >
                  {t.logoURI && <img src={t.logoURI} alt="" className="w-4 h-4 rounded-full" />}
                  <span className="text-xs text-white font-medium">{t.symbol}</span>
                </button>
              ))}
            </div>
            {/* Token list */}
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {filteredTokens.map(t => (
                <button
                  key={t.address}
                  onClick={() => {
                    if (showTokenSelector === 'input') setInputToken(t);
                    else setOutputToken(t);
                    setShowTokenSelector(null);
                    setTokenSearch('');
                    setInputAmount('');
                    setOutputAmount('');
                    setQuote(null);
                  }}
                  className="w-full flex items-center gap-3 p-3 hover:bg-p01-surface rounded-xl transition-colors"
                >
                  {t.logoURI ? (
                    <img src={t.logoURI} alt="" className="w-8 h-8 rounded-full" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-p01-elevated flex items-center justify-center text-xs text-p01-chrome">{t.symbol[0]}</div>
                  )}
                  <div className="text-left">
                    <p className="text-white text-sm font-medium">{t.symbol}</p>
                    <p className="text-p01-chrome text-xs">{t.name}</p>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TokenButton({ token, onClick }: { token: JupiterToken; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label={`Select ${token.symbol} token`} className="flex items-center gap-2 px-3 py-2 bg-p01-elevated rounded-xl hover:bg-p01-border transition-colors shrink-0">
      {token.logoURI ? (
        <img src={token.logoURI} alt="" className="w-5 h-5 rounded-full" />
      ) : (
        <div className="w-5 h-5 rounded-full bg-p01-surface flex items-center justify-center text-[10px] text-p01-chrome">{token.symbol[0]}</div>
      )}
      <span className="text-white text-sm font-medium">{token.symbol}</span>
      <ChevronDown className="w-3.5 h-3.5 text-p01-chrome" />
    </button>
  );
}
