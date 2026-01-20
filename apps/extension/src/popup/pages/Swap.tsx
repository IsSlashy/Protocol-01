import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowDownUp, ChevronDown, Settings2, Loader2 } from 'lucide-react';
// Utils imported if needed in future
// import { cn } from '@/shared/utils';

const tokens = [
  { symbol: 'SOL', name: 'Solana', balance: 12.5, price: 100 },
  { symbol: 'USDC', name: 'USD Coin', balance: 500, price: 1 },
  { symbol: 'USDT', name: 'Tether', balance: 0, price: 1 },
  { symbol: 'RAY', name: 'Raydium', balance: 0, price: 2.5 },
];

export default function Swap() {
  const navigate = useNavigate();
  const [fromToken, setFromToken] = useState(tokens[0]);
  const [toToken, setToToken] = useState(tokens[1]);
  const [fromAmount, setFromAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showFromSelect, setShowFromSelect] = useState(false);
  const [showToSelect, setShowToSelect] = useState(false);

  const toAmount = fromAmount
    ? ((parseFloat(fromAmount) * fromToken.price) / toToken.price).toFixed(4)
    : '';

  const handleSwapTokens = () => {
    const temp = fromToken;
    setFromToken(toToken);
    setToToken(temp);
    setFromAmount('');
  };

  const handleSwap = async () => {
    if (!fromAmount) return;
    setIsLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setIsLoading(false);
    navigate('/');
  };

  const rate = (fromToken.price / toToken.price).toFixed(4);

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
        <button className="p-2 hover:bg-p01-surface rounded-lg transition-colors">
          <Settings2 className="w-5 h-5 text-p01-chrome" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* From Token */}
        <div className="bg-p01-surface rounded-xl p-4 relative">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-p01-chrome/60">From</span>
            <span className="text-xs text-p01-chrome/60">
              Balance: {fromToken.balance}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowFromSelect(true)}
              className="flex items-center gap-2 px-3 py-2 bg-p01-border rounded-lg hover:bg-p01-border transition-colors"
            >
              <div className="w-6 h-6 rounded-full bg-p01-elevated flex items-center justify-center">
                <span className="text-xs font-bold text-p01-chrome">
                  {fromToken.symbol.slice(0, 2)}
                </span>
              </div>
              <span className="text-sm font-medium text-white">
                {fromToken.symbol}
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
                onClick={() =>
                  setFromAmount(String((fromToken.balance * percent) / 100))
                }
                className="flex-1 py-1.5 text-xs font-medium bg-p01-border text-p01-chrome rounded-lg hover:bg-p01-border transition-colors"
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
              Balance: {toToken.balance}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowToSelect(true)}
              className="flex items-center gap-2 px-3 py-2 bg-p01-border rounded-lg hover:bg-p01-border transition-colors"
            >
              <div className="w-6 h-6 rounded-full bg-p01-elevated flex items-center justify-center">
                <span className="text-xs font-bold text-p01-chrome">
                  {toToken.symbol.slice(0, 2)}
                </span>
              </div>
              <span className="text-sm font-medium text-white">
                {toToken.symbol}
              </span>
              <ChevronDown className="w-4 h-4 text-p01-chrome/60" />
            </button>

            <div className="flex-1 text-right">
              <span className="text-2xl font-display font-bold text-white">
                {toAmount || '0.00'}
              </span>
            </div>
          </div>
        </div>

        {/* Rate Info */}
        {fromAmount && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 p-3 bg-p01-surface rounded-xl"
          >
            <div className="flex justify-between text-sm">
              <span className="text-p01-chrome/60">Rate</span>
              <span className="text-white">
                1 {fromToken.symbol} = {rate} {toToken.symbol}
              </span>
            </div>
            <div className="flex justify-between text-sm mt-2">
              <span className="text-p01-chrome/60">Fee</span>
              <span className="text-white">~0.3%</span>
            </div>
          </motion.div>
        )}
      </div>

      {/* Swap Button */}
      <div className="p-4 border-t border-p01-border">
        <button
          onClick={handleSwap}
          disabled={!fromAmount || isLoading}
          className="w-full py-3.5 bg-p01-cyan text-p01-void font-semibold rounded-xl hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Swapping...
            </>
          ) : (
            'Swap'
          )}
        </button>
      </div>

      {/* Token Select Modal */}
      {(showFromSelect || showToSelect) && (
        <div
          className="absolute inset-0 bg-black/80 flex items-end"
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
                  key={token.symbol}
                  onClick={() => {
                    if (showFromSelect) {
                      setFromToken(token);
                      setShowFromSelect(false);
                    } else {
                      setToToken(token);
                      setShowToSelect(false);
                    }
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-p01-elevated transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-p01-border flex items-center justify-center">
                    <span className="text-sm font-bold text-p01-chrome">
                      {token.symbol.slice(0, 2)}
                    </span>
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-sm font-medium text-white">
                      {token.symbol}
                    </p>
                    <p className="text-xs text-p01-chrome/60">
                      {token.name}
                    </p>
                  </div>
                  <p className="text-sm text-p01-chrome">
                    {token.balance}
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
