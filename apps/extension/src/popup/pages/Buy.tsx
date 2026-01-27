import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  CreditCard,
  Building,
  ChevronDown,
  Zap,
  Shield,
  Lock,
  Loader2,
  ExternalLink,
  Check,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { cn, formatCurrency } from '@/shared/utils';
import {
  getCryptoPrices,
  getPaymentQuote,
  createPaymentSession,
  SUPPORTED_ASSETS,
  SUPPORTED_FIAT,
  PAYMENT_METHODS,
  P01_NETWORK_FEE_BPS,
  type PaymentQuote,
  type CryptoAsset,
  type FiatCurrency,
  type PaymentMethod,
} from '@/shared/services/p01-payments';

const ASSET_ICONS: Record<string, string> = {
  SOL: '◎',
  USDC: '$',
  USDT: '₮',
};

const ASSET_COLORS: Record<string, string> = {
  SOL: '#39c5bb',
  USDC: '#2775CA',
  USDT: '#26A17B',
};

const QUICK_AMOUNTS = [50, 100, 250, 500];

export default function Buy() {
  const navigate = useNavigate();
  const { publicKey, network } = useWalletStore();

  const [selectedAsset, setSelectedAsset] = useState<CryptoAsset>(SUPPORTED_ASSETS[0]);
  const [selectedFiat, setSelectedFiat] = useState<FiatCurrency>(SUPPORTED_FIAT[0]);
  const [selectedPayment, setSelectedPayment] = useState<PaymentMethod>(PAYMENT_METHODS[0]);
  const [amount, setAmount] = useState('100');
  const [isLoading, setIsLoading] = useState(false);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [priceLoading, setPriceLoading] = useState(true);

  const isMainnet = network === 'mainnet-beta';

  // Fetch prices
  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const newPrices = await getCryptoPrices();
        setPrices(newPrices);
      } catch (error) {
        console.error('Failed to fetch prices:', error);
      } finally {
        setPriceLoading(false);
      }
    };
    fetchPrices();
    const interval = setInterval(fetchPrices, 30000);
    return () => clearInterval(interval);
  }, []);

  // Update quote when inputs change
  useEffect(() => {
    const updateQuote = async () => {
      const numAmount = parseFloat(amount) || 0;
      if (numAmount > 0 && prices[selectedAsset.symbol]) {
        try {
          const newQuote = await getPaymentQuote({
            fiatAmount: numAmount,
            fiatCurrency: selectedFiat.code,
            cryptoSymbol: selectedAsset.symbol,
            paymentMethodId: selectedPayment.id,
          });
          setQuote(newQuote);
        } catch (error) {
          console.error('Failed to get quote:', error);
        }
      } else {
        setQuote(null);
      }
    };
    updateQuote();
  }, [amount, selectedAsset, selectedFiat, selectedPayment, prices]);

  const handleAmountChange = (text: string) => {
    const cleaned = text.replace(/[^0-9.]/g, '');
    const parts = cleaned.split('.');
    if (parts.length > 2) return;
    if (parts[1]?.length > 2) return;
    setAmount(cleaned);
  };

  const handleBuy = async () => {
    if (!publicKey || !quote) return;

    setIsLoading(true);
    try {
      const session = await createPaymentSession({
        quote,
        walletAddress: publicKey,
        paymentMethodId: selectedPayment.id,
      });
      // Open payment URL in new tab
      window.open(session.paymentUrl, '_blank');
    } catch (error) {
      console.error('Payment error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const assetColor = ASSET_COLORS[selectedAsset.symbol] || '#39c5bb';
  const p01FeePercent = P01_NETWORK_FEE_BPS / 100;
  const paymentFeePercent = selectedPayment.feeBps / 100;

  const PaymentIcon = selectedPayment.id === 'card' ? CreditCard : Building;

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-white font-display font-bold tracking-wide">Buy Crypto</h1>
          <p className="text-p01-cyan text-[10px] font-mono tracking-wider">P-01 NETWORK</p>
        </div>
        <div className="w-9" />
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Devnet Warning */}
        {!isMainnet && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-3 flex items-center gap-3"
          >
            <Zap className="w-5 h-5 text-orange-400 flex-shrink-0" />
            <p className="text-orange-400 text-xs">
              Switch to mainnet to buy real crypto.
            </p>
          </motion.div>
        )}

        {/* Amount Input */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <p className="text-p01-chrome text-[10px] font-mono tracking-widest mb-2">YOU PAY</p>
          <div className="bg-p01-surface rounded-xl border border-p01-border p-4">
            <div className="flex items-center gap-2">
              <span className="text-white text-2xl font-bold">{selectedFiat.symbol}</span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => handleAmountChange(e.target.value)}
                className="flex-1 bg-transparent text-white text-2xl font-bold outline-none placeholder:text-p01-chrome/40"
                placeholder="0.00"
              />
              <span className="text-p01-chrome text-sm font-mono">{selectedFiat.code}</span>
            </div>
            {/* Quick amounts */}
            <div className="flex gap-2 mt-3">
              {QUICK_AMOUNTS.map((value) => (
                <button
                  key={value}
                  onClick={() => setAmount(value.toString())}
                  className={cn(
                    'flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors',
                    amount === value.toString()
                      ? 'bg-p01-cyan/15 text-p01-cyan border border-p01-cyan/30'
                      : 'bg-p01-dark text-p01-chrome hover:text-white'
                  )}
                >
                  {selectedFiat.symbol}{value}
                </button>
              ))}
            </div>
          </div>
        </motion.div>

        {/* You Receive */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <p className="text-p01-chrome text-[10px] font-mono tracking-widest mb-2">YOU RECEIVE</p>
          <div className="bg-p01-surface rounded-xl border border-p01-border p-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold"
                style={{ backgroundColor: assetColor + '20', color: assetColor }}
              >
                {ASSET_ICONS[selectedAsset.symbol] || '?'}
              </div>
              <div className="flex-1">
                <p className="text-white text-lg font-bold">
                  {quote ? quote.cryptoAmount.toFixed(selectedAsset.symbol === 'SOL' ? 4 : 2) : '0.00'} {selectedAsset.symbol}
                </p>
                <p className="text-p01-chrome text-xs">
                  {selectedAsset.name}
                  {prices[selectedAsset.symbol] ? ` @ $${prices[selectedAsset.symbol].toLocaleString()}` : ''}
                </p>
              </div>
            </div>
            {/* Asset selector */}
            <div className="flex gap-2 mt-3">
              {SUPPORTED_ASSETS.map((asset) => (
                <button
                  key={asset.symbol}
                  onClick={() => setSelectedAsset(asset)}
                  className={cn(
                    'flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                    selectedAsset.symbol === asset.symbol
                      ? 'border text-white'
                      : 'bg-p01-dark text-p01-chrome hover:text-white'
                  )}
                  style={
                    selectedAsset.symbol === asset.symbol
                      ? {
                          backgroundColor: (ASSET_COLORS[asset.symbol] || '#39c5bb') + '15',
                          borderColor: (ASSET_COLORS[asset.symbol] || '#39c5bb') + '40',
                          color: ASSET_COLORS[asset.symbol] || '#39c5bb',
                        }
                      : undefined
                  }
                >
                  {asset.symbol}
                </button>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Payment Method */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <p className="text-p01-chrome text-[10px] font-mono tracking-widest mb-2">PAYMENT METHOD</p>
          <div className="space-y-2">
            {PAYMENT_METHODS.map((method) => {
              const Icon = method.id === 'card' ? CreditCard : Building;
              const isSelected = selectedPayment.id === method.id;
              return (
                <button
                  key={method.id}
                  onClick={() => setSelectedPayment(method)}
                  className={cn(
                    'w-full flex items-center gap-3 p-3 rounded-xl border transition-colors text-left',
                    isSelected
                      ? 'bg-p01-cyan/10 border-p01-cyan/30'
                      : 'bg-p01-surface border-p01-border hover:border-p01-chrome/30'
                  )}
                >
                  <Icon className={cn('w-5 h-5', isSelected ? 'text-p01-cyan' : 'text-p01-chrome')} />
                  <div className="flex-1">
                    <p className="text-white text-sm font-medium">{method.name}</p>
                    <p className="text-p01-chrome text-[11px]">
                      {method.processingTime} &middot; {(method.feeBps / 100).toFixed(1)}% fee
                    </p>
                  </div>
                  {isSelected && <Check className="w-4 h-4 text-p01-cyan" />}
                </button>
              );
            })}
          </div>
        </motion.div>

        {/* Fee Breakdown */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <p className="text-p01-chrome text-[10px] font-mono tracking-widest mb-2">FEE BREAKDOWN</p>
          <div className="bg-p01-surface rounded-xl border border-p01-border p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-p01-chrome">Subtotal</span>
              <span className="text-white">{selectedFiat.symbol}{quote?.fiatAmount.toFixed(2) || '0.00'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-p01-chrome">Payment Fee ({paymentFeePercent.toFixed(1)}%)</span>
              <span className="text-white">-{selectedFiat.symbol}{quote?.paymentMethodFee.toFixed(2) || '0.00'}</span>
            </div>
            <div className="flex justify-between text-sm items-center">
              <span className="flex items-center gap-1.5 text-p01-chrome">
                P-01 Network ({p01FeePercent.toFixed(1)}%)
                <span className="text-[9px] text-p01-cyan bg-p01-cyan/10 px-1.5 py-0.5 rounded font-mono">P-01</span>
              </span>
              <span className="text-white">-{selectedFiat.symbol}{quote?.p01NetworkFee.toFixed(2) || '0.00'}</span>
            </div>
            <div className="border-t border-p01-border pt-2 flex justify-between">
              <span className="text-white font-medium">Net Amount</span>
              <span className="text-p01-cyan font-bold">{selectedFiat.symbol}{quote?.netAmount.toFixed(2) || '0.00'}</span>
            </div>
          </div>
        </motion.div>

        {/* Security Info */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-p01-surface rounded-xl border border-p01-border p-3 space-y-2"
        >
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-green-400" />
            <span className="text-p01-chrome text-xs">Secure payment processing</span>
          </div>
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-p01-cyan" />
            <span className="text-p01-chrome text-xs">End-to-end encrypted</span>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-p01-pink" />
            <span className="text-p01-chrome text-xs">Instant delivery to your wallet</span>
          </div>
        </motion.div>
      </div>

      {/* Buy Button */}
      <div className="px-4 py-3 border-t border-p01-border">
        <button
          onClick={handleBuy}
          disabled={!publicKey || !isMainnet || isLoading || !quote || priceLoading}
          className={cn(
            'w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all',
            publicKey && isMainnet && quote && !isLoading && !priceLoading
              ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
              : 'bg-p01-surface text-p01-chrome cursor-not-allowed'
          )}
        >
          {isLoading || priceLoading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              <Zap className="w-4 h-4" />
              Buy {quote ? `${quote.cryptoAmount.toFixed(4)} ${selectedAsset.symbol}` : selectedAsset.symbol}
            </>
          )}
        </button>
        <p className="text-center text-p01-chrome/50 text-[10px] mt-2 font-mono">
          Powered by P-01 Network
        </p>
      </div>
    </div>
  );
}
