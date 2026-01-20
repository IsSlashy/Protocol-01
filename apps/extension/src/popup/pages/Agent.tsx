import { Sparkles, Bot, Zap, Shield } from 'lucide-react';

export default function Agent() {
  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border">
        <h1 className="text-white font-display font-bold tracking-wide">AI Agent</h1>
        <span className="px-2 py-0.5 bg-violet-500/20 text-violet-400 text-[10px] font-mono font-bold rounded">
          BETA
        </span>
      </header>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center mb-4">
          <Sparkles className="w-8 h-8 text-white" />
        </div>
        <h2 className="text-white font-display font-bold text-lg mb-2">Protocol Agent</h2>
        <p className="text-p01-chrome text-sm text-center mb-6">
          Your AI-powered assistant for automated transactions and smart operations.
        </p>

        <div className="w-full space-y-3">
          <div className="p-4 bg-p01-surface rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center">
              <Bot className="w-5 h-5 text-p01-cyan" />
            </div>
            <div className="text-left flex-1">
              <p className="text-white font-medium">Auto-Swap</p>
              <p className="text-p01-chrome text-xs">Automatic token swaps at target prices</p>
            </div>
            <span className="text-p01-chrome/40 text-xs">Soon</span>
          </div>

          <div className="p-4 bg-p01-surface rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center">
              <Zap className="w-5 h-5 text-orange-400" />
            </div>
            <div className="text-left flex-1">
              <p className="text-white font-medium">DCA Bot</p>
              <p className="text-p01-chrome text-xs">Dollar-cost averaging automation</p>
            </div>
            <span className="text-p01-chrome/40 text-xs">Soon</span>
          </div>

          <div className="p-4 bg-p01-surface rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-p01-pink/20 flex items-center justify-center">
              <Shield className="w-5 h-5 text-p01-pink" />
            </div>
            <div className="text-left flex-1">
              <p className="text-white font-medium">Guardian</p>
              <p className="text-p01-chrome text-xs">Automatic security monitoring</p>
            </div>
            <span className="text-p01-chrome/40 text-xs">Soon</span>
          </div>
        </div>
      </div>
    </div>
  );
}
