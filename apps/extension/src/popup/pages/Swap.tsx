import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowDownUp, ChevronDown, Settings2, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { VersionedTransaction } from '@solana/web3.js';
import { useWalletStore } from '@/shared/store/wallet';
import TokenIcon from '@/popup/components/TokenIcon';
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
} from '@/shared/services/jupiter';
import { getConnection } from '@/shared/services/wallet';

interface TokenWithBalance extends JupiterToken {
  balance: number;
  uiBalance: string;
}

export default function Swap() {
  const navigate = useNavigate();
  const { _keypair: keypair, network, solBalance } = useWalletStore();

  // Token state
  const [tokens, setTokens] = useState<TokenWithBalance[]>([]);
  const [fromToken, setFromToken] = useState<TokenWithBalance | null>(null);
  const [toToken, setToToken] = useState<TokenWithBalance | null>(null);
  const [fromAmount, setFromAmount] = useState('');

  // Quote state
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Swap state
  const [isSwapping, setIsSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);

  // UI state
  const [showFromSelect, setShowFromSelect] = useState(false);
  const [showToSelect, setShowToSelect] = useState(false);
  const [slippageBps, setSlippageBps] = useState(50); // 0.5% default
  const [showSettings, setShowSettings] = useState(false);

  // Load popular tokens on mount
  useEffect(() => {
    async function loadTokens() {
      try {
        const popularTokens = await getPopularTokens();

        // Add balances (SOL balance from store, others would need token account queries)
        const tokensWithBalance: TokenWithBalance[] = popularTokens.map(token => ({
          ...token,
          balance: token.address === TOKEN_MINTS.SOL ? solBalance : 0,
          uiBalance: token.address === TOKEN_MINTS.SOL ? solBalance.toFixed(4) : '0',
        }));

        setTokens(tokensWithBalance);

        // Set defaults
        const sol = tokensWithBalance.find(t => t.address === TOKEN_MINTS.SOL);
        const usdc = tokensWithBalance.find(t => t.address === TOKEN_MINTS.USDC);

        if (sol) setFromToken(sol);
        if (usdc) setToToken(usdc);
      } catch (error) {
        console.error('Failed to load tokens:', error);
      }
    }

    loadTokens();
  }, [solBalance]);

  // Fetch quote when input changes
  const fetchQuote = useCallback(async () => {
    if (!fromToken || !toToken || !fromAmount || parseFloat(fromAmount) <= 0) {
      setQuote(null);
      return;
    }

    setIsLoadingQuote(true);
    setQuoteError(null);

    try {
      const amountIn = parseTokenAmount(fromAmount, fromToken.decimals);

      const quoteResponse = await getQuote({
        inputMint: fromToken.address,
        outputMint: toToken.address,
        amount: amountIn.toString(),
        slippageBps,
      });

      setQuote(quoteResponse);
    } catch (error) {
      console.error('Quote error:', error);
      setQuoteError((error as Error).message);
      setQuote(null);
    } finally {
      setIsLoadingQuote(false);
    }
  }, [fromToken, toToken, fromAmount, slippageBps]);

  // Debounced quote fetching
  useEffect(() => {
    const timer = setTimeout(fetchQuote, 500);
    return () => clearTimeout(timer);
  }, [fetchQuote]);

  const handleSwapTokens = () => {
    const temp = fromToken;
    setFromToken(toToken);
    setToToken(temp);
    setFromAmount('');
    setQuote(null);
  };

  const handleSwap = async () => {
    if (!keypair || !fromToken || !toToken || !quote) return;

    setIsSwapping(true);
    setSwapError(null);

    try {
      const connection = getConnection(network);

      // Get swap transaction
      const swapResponse = await getSwapTransaction({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
      });

      // Sign and execute
      const signature = await executeSwap({
        connection,
        swapTransaction: swapResponse.swapTransaction,
        signTransaction: async (tx: VersionedTransaction) => {
          tx.sign([keypair]);
          return tx;
        },
      });

      console.log('Swap successful:', signature);

      // Navigate back with success
      navigate('/', { state: { swapSuccess: true, signature } });
    } catch (error) {
      console.error('Swap error:', error);
      setSwapError((error as Error).message);
    } finally {
      setIsSwapping(false);
    }
  };

  const toAmount = quote
    ? formatTokenAmount(quote.outAmount, toToken?.decimals || 6)
    : '';

  const priceImpact = quote ? parseFloat(quote.priceImpactPct) : 0;
  const priceImpactSeverity = quote ? getPriceImpactSeverity(quote.priceImpactPct) : 'low';

  const rate = quote && fromToken && toToken
    ? (parseFloat(formatTokenAmount(quote.outAmount, toToken.decimals)) /
       parseFloat(formatTokenAmount(quote.inAmount, fromToken.decimals))).toFixed(6)
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-p01-border">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 hover:bg-p01-surface rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-p01-chrome" />
          </button>
          <h1 className="text-lg font-semibold text-white">Swap</h1>
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="p-2 hover:bg-p01-surface rounded-lg transition-colors"
        >
          <Settings2 className="w-5 h-5 text-p01-chrome" />
        </button>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="px-4 py-3 bg-p01-surface border-b border-p01-border"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm text-p01-chrome">Slippage Tolerance</span>
            <div className="flex gap-2">
              {[50, 100, 300].map((bps) => (
                <button
                  key={bps}
                  onClick={() => setSlippageBps(bps)}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                    slippageBps === bps
                      ? 'bg-p01-cyan text-p01-void'
                      : 'bg-p01-border text-p01-chrome hover:bg-p01-elevated'
                  }`}
                >
                  {(bps / 100).toFixed(1)}%
                </button>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {/* From Token */}
        <div className="bg-p01-surface rounded-xl p-4 relative">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-p01-chrome/60">From</span>
            <span className="text-xs text-p01-chrome/60">
              Balance: {fromToken?.uiBalance || '0'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowFromSelect(true)}
              className="flex items-center gap-2 px-3 py-2 bg-p01-border rounded-lg hover:bg-p01-elevated transition-colors"
            >
              {fromToken ? (
                <TokenIcon symbol={fromToken.symbol} logoURI={fromToken.logoURI} size="sm" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-p01-elevated flex items-center justify-center">
                  <span className="text-xs font-bold text-p01-chrome">??</span>
                </div>
              )}
              <span className="text-sm font-medium text-white">
                {fromToken?.symbol || 'Select'}
              </span>
              <ChevronDown className="w-4 h-4 text-p01-chrome/60" />
            </button>

            <input
              type="number"
              value={fromAmount}
              onChange={(e) => setFromAmount(e.target.value)}
              placeholder="0.00"
              className="flex-1 text-right bg-transparent text-2xl font-display font-bold text-white placeholder-p01-chrome/40 focus:outline-none"
            />
          </div>

          <div className="flex gap-2 mt-3">
            {[25, 50, 75, 100].map((percent) => (
              <button
                key={percent}
                onClick={() => {
                  if (fromToken) {
                    const amount = (fromToken.balance * percent) / 100;
                    setFromAmount(amount.toFixed(fromToken.decimals > 6 ? 6 : fromToken.decimals));
                  }
                }}
                className="flex-1 py-1.5 text-xs font-medium bg-p01-border text-p01-chrome rounded-lg hover:bg-p01-elevated transition-colors"
              >
                {percent}%
              </button>
            ))}
          </div>
        </div>

        {/* Swap Button */}
        <div className="flex justify-center -my-3 relative z-10">
          <button
            onClick={handleSwapTokens}
            className="w-10 h-10 rounded-full bg-p01-elevated border-4 border-p01-void flex items-center justify-center hover:bg-p01-border transition-colors"
          >
            <ArrowDownUp className="w-4 h-4 text-p01-chrome" />
          </button>
        </div>

        {/* To Token */}
        <div className="bg-p01-surface rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-p01-chrome/60">To</span>
            <span className="text-xs text-p01-chrome/60">
              Balance: {toToken?.uiBalance || '0'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowToSelect(true)}
              className="flex items-center gap-2 px-3 py-2 bg-p01-border rounded-lg hover:bg-p01-elevated transition-colors"
            >
              {toToken ? (
                <TokenIcon symbol={toToken.symbol} logoURI={toToken.logoURI} size="sm" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-p01-elevated flex items-center justify-center">
                  <span className="text-xs font-bold text-p01-chrome">??</span>
                </div>
              )}
              <span className="text-sm font-medium text-white">
                {toToken?.symbol || 'Select'}
              </span>
              <ChevronDown className="w-4 h-4 text-p01-chrome/60" />
            </button>

            <div className="flex-1 text-right flex items-center justify-end gap-2">
              {isLoadingQuote ? (
                <Loader2 className="w-5 h-5 animate-spin text-p01-chrome/60" />
              ) : (
                <span className="text-2xl font-display font-bold text-white">
                  {toAmount || '0.00'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Quote Info */}
        {quote && fromToken && toToken && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 p-3 bg-p01-surface rounded-xl space-y-2"
          >
            <div className="flex justify-between text-sm">
              <span className="text-p01-chrome/60">Rate</span>
              <span className="text-white">
                1 {fromToken.symbol} = {rate} {toToken.symbol}
              </span>
            </div>

            <div className="flex justify-between text-sm">
              <span className="text-p01-chrome/60">Price Impact</span>
              <span className={`${
                priceImpactSeverity === 'high' ? 'text-red-400' :
                priceImpactSeverity === 'medium' ? 'text-yellow-400' :
                'text-green-400'
              }`}>
                {priceImpact.toFixed(2)}%
              </span>
            </div>

            <div className="flex justify-between text-sm">
              <span className="text-p01-chrome/60">Slippage</span>
              <span className="text-white">{(slippageBps / 100).toFixed(1)}%</span>
            </div>

            <div className="flex justify-between text-sm">
              <span className="text-p01-chrome/60">Route</span>
              <span className="text-white">
                {quote.routePlan.map(r => r.swapInfo.label).join(' → ')}
              </span>
            </div>

            <button
              onClick={fetchQuote}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs text-p01-chrome hover:text-white transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Refresh Quote
            </button>
          </motion.div>
        )}

        {/* Errors */}
        {(quoteError || swapError) && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-400">{quoteError || swapError}</p>
          </div>
        )}

        {/* High price impact warning */}
        {priceImpactSeverity === 'high' && (
          <div className="mt-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-400">
              High price impact! You may receive significantly less than expected.
            </p>
          </div>
        )}
      </div>

      {/* Swap Button */}
      <div className="p-4 border-t border-p01-border">
        <button
          onClick={handleSwap}
          disabled={!quote || isSwapping || isLoadingQuote}
          className="w-full py-3.5 bg-p01-cyan text-p01-void font-semibold rounded-xl hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isSwapping ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Swapping...
            </>
          ) : isLoadingQuote ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Getting Quote...
            </>
          ) : !quote ? (
            'Enter Amount'
          ) : (
            'Swap'
          )}
        </button>
      </div>

      {/* Token Select Modal */}
      {(showFromSelect || showToSelect) && (
        <div
          className="absolute inset-0 bg-black/80 flex items-end z-50"
          onClick={() => {
            setShowFromSelect(false);
            setShowToSelect(false);
          }}
        >
          <motion.div
            initial={{ y: 200 }}
            animate={{ y: 0 }}
            className="w-full bg-p01-surface rounded-t-2xl p-4 max-h-[70%] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              Select Token
            </h3>
            <div className="space-y-2">
              {tokens.map((token) => (
                <button
                  key={token.address}
                  onClick={() => {
                    if (showFromSelect) {
                      setFromToken(token);
                      setShowFromSelect(false);
                    } else {
                      setToToken(token);
                      setShowToSelect(false);
                    }
                    setQuote(null);
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-p01-elevated transition-colors"
                >
                  <TokenIcon symbol={token.symbol} logoURI={token.logoURI} size="md" />
                  <div className="flex-1 text-left">
                    <p className="text-sm font-medium text-white">
                      {token.symbol}
                    </p>
                    <p className="text-xs text-p01-chrome/60">
                      {token.name}
                    </p>
                  </div>
                  <p className="text-sm text-p01-chrome">
                    {token.uiBalance}
                  </p>
                </button>
              ))}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
