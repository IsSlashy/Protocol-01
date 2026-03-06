import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles,
  Settings,
  Send,
  Plus,
  Trash2,
  X,
  Check,
  Loader2,
  ChevronDown,
  MessageSquare,
  TrendingUp,
  BarChart3,
  Wallet,
  HelpCircle,
  AlertTriangle,
} from 'lucide-react';
import { useAIStore, type DisplayMessage } from '../../shared/store/ai';
import { DEFAULT_CONFIGS, type AIConfig } from '../../shared/services/ai/agent';

const QUICK_ACTIONS = [
  { label: 'SOL Price', icon: TrendingUp, color: 'text-green-400' },
  { label: 'Fear & Greed', icon: BarChart3, color: 'text-yellow-400' },
  { label: 'My Portfolio', icon: Wallet, color: 'text-p01-cyan' },
  { label: 'Market Summary', icon: TrendingUp, color: 'text-purple-400' },
  { label: 'Help', icon: HelpCircle, color: 'text-p01-chrome' },
];

export default function Agent() {
  const {
    config,
    isConnected,
    messages,
    isLoading,
    error,
    marketData,
    streamingMessage,
    conversations,
    activeConversationId,
    initialize,
    updateConfig,
    testConnection: testConn,
    sendMessageStreaming,
    clearMessages,
    clearError,
    refreshMarketData,
    createConversation,
    switchConversation,
    deleteConversation,
  } = useAIStore();

  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<'groq' | 'gemma-cloud' | 'ollama'>(config.provider);
  const [settingsApiKey, setSettingsApiKey] = useState(config.groqApiKey || config.apiKey || '');
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    initialize();
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingMessage]);

  const handleSend = async (text?: string) => {
    const content = text || input.trim();
    if (!content || isLoading) return;

    setInput('');
    await sendMessageStreaming(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSaveSettings = async () => {
    const providerConfig = DEFAULT_CONFIGS[settingsProvider] || {};
    const updates: Partial<AIConfig> = {
      ...providerConfig,
      provider: settingsProvider as AIConfig['provider'],
    };
    if (settingsProvider === 'groq') {
      updates.groqApiKey = settingsApiKey;
    } else {
      updates.apiKey = settingsApiKey;
    }
    await updateConfig(updates);
    setShowSettings(false);
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    const tempConfig: AIConfig = {
      ...(DEFAULT_CONFIGS[settingsProvider] as AIConfig),
      provider: settingsProvider as AIConfig['provider'],
      ...(settingsProvider === 'groq' ? { groqApiKey: settingsApiKey } : { apiKey: settingsApiKey }),
    };

    // Temporarily update to test
    const result = await testConn();
    setTestResult(result);
    setIsTesting(false);
  };

  const hasMessages = messages.length > 0;
  const solPrice = marketData?.prices?.SOL;
  const fearGreed = marketData?.fearGreed;

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-white font-display font-bold tracking-wide">P-01 Agent</h1>
          <span className="px-2 py-0.5 bg-p01-cyan/20 text-p01-cyan text-[10px] font-mono font-bold rounded">
            BETA
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { createConversation(); }}
            className="p-2 hover:bg-p01-surface rounded-lg transition-colors"
            title="New chat"
            aria-label="New chat"
          >
            <Plus className="w-4 h-4 text-p01-chrome" />
          </button>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="p-2 hover:bg-p01-surface rounded-lg transition-colors"
            title="Chat history"
            aria-label="Chat history"
            aria-expanded={showHistory}
          >
            <MessageSquare className="w-4 h-4 text-p01-chrome" />
          </button>
          <button
            onClick={() => {
              setShowSettings(!showSettings);
              setSettingsProvider(config.provider);
              setSettingsApiKey(config.groqApiKey || config.apiKey || '');
              setTestResult(null);
            }}
            className="p-2 hover:bg-p01-surface rounded-lg transition-colors"
            title="Settings"
            aria-label="Settings"
            aria-expanded={showSettings}
          >
            <Settings className="w-4 h-4 text-p01-chrome" />
          </button>
        </div>
      </header>

      {/* Settings panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-p01-border"
          >
            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs text-p01-chrome block mb-1.5">Provider</label>
                <div className="flex gap-2">
                  {['groq', 'gemma-cloud', 'ollama'].map(p => (
                    <button
                      key={p}
                      onClick={() => {
                        setSettingsProvider(p as 'groq' | 'gemma-cloud' | 'ollama');
                        setSettingsApiKey('');
                        setTestResult(null);
                      }}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                        settingsProvider === p
                          ? 'bg-p01-cyan text-p01-void'
                          : 'bg-p01-surface text-p01-chrome hover:bg-p01-elevated'
                      }`}
                    >
                      {p === 'groq' ? 'Groq' : p === 'gemma-cloud' ? 'Gemma' : 'Ollama'}
                    </button>
                  ))}
                </div>
              </div>

              {settingsProvider !== 'ollama' && (
                <div>
                  <label htmlFor="agent-api-key" className="text-xs text-p01-chrome block mb-1.5">
                    {settingsProvider === 'groq' ? 'Groq API Key' : 'Google AI API Key'}
                  </label>
                  <input
                    id="agent-api-key"
                    type="password"
                    value={settingsApiKey}
                    onChange={e => setSettingsApiKey(e.target.value)}
                    placeholder={settingsProvider === 'groq' ? 'gsk_...' : 'AIza...'}
                    className="w-full bg-p01-surface rounded-lg px-3 py-2 text-sm text-white placeholder-p01-chrome/40 outline-none border border-p01-border focus:border-p01-cyan/50"
                  />
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleTestConnection}
                  disabled={isTesting}
                  className="flex-1 py-2 bg-p01-surface text-white text-xs font-medium rounded-lg hover:bg-p01-elevated transition-colors flex items-center justify-center gap-1.5"
                >
                  {isTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Test
                </button>
                <button
                  onClick={handleSaveSettings}
                  className="flex-1 py-2 bg-p01-cyan text-p01-void text-xs font-medium rounded-lg hover:bg-p01-cyan/90 transition-colors"
                >
                  Save
                </button>
              </div>

              {testResult && (
                <div className={`flex items-center gap-2 text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`} role="status" aria-live="polite">
                  {testResult.success ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                  {testResult.success ? 'Connected!' : testResult.error || 'Connection failed'}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat history panel */}
      <AnimatePresence>
        {showHistory && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-p01-border max-h-[200px]"
          >
            <div className="p-3 overflow-y-auto max-h-[200px]">
              {conversations.length === 0 ? (
                <p className="text-xs text-p01-chrome text-center py-2">No conversations yet</p>
              ) : (
                <div className="space-y-1">
                  {conversations.map(conv => (
                    <div
                      key={conv.id}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        activeConversationId === conv.id ? 'bg-p01-cyan/10 border border-p01-cyan/30' : 'hover:bg-p01-surface'
                      }`}
                      onClick={() => { switchConversation(conv.id); setShowHistory(false); }}
                    >
                      <MessageSquare className="w-3.5 h-3.5 text-p01-chrome shrink-0" />
                      <span className="text-xs text-white truncate flex-1">{conv.title}</span>
                      <button
                        onClick={e => { e.stopPropagation(); deleteConversation(conv.id); }}
                        className="p-1 hover:bg-p01-elevated rounded shrink-0"
                        aria-label="Delete conversation"
                      >
                        <Trash2 className="w-3 h-3 text-p01-chrome" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {!hasMessages ? (
          /* Welcome state */
          <div className="flex flex-col items-center pt-8 px-4">
            {/* Agent avatar */}
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-p01-cyan to-p01-cyan-dim flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-white font-display font-bold text-lg mb-1">P-01 Agent</h2>
            <p className="text-p01-chrome text-xs text-center mb-4">Your AI-powered crypto assistant</p>

            {/* Market snapshot */}
            {(solPrice || fearGreed) && (
              <div className="flex items-center gap-3 px-4 py-2 bg-p01-surface rounded-full mb-6">
                {solPrice && <span className="text-xs text-white">SOL ${solPrice.toFixed(2)}</span>}
                {solPrice && fearGreed && <span className="text-p01-chrome text-xs">|</span>}
                {fearGreed && (
                  <span className={`text-xs ${fearGreed.value < 30 ? 'text-red-400' : fearGreed.value > 70 ? 'text-green-400' : 'text-yellow-400'}`}>
                    F&G: {fearGreed.value}
                  </span>
                )}
              </div>
            )}

            {/* Connection warning */}
            {!isConnected && (
              <div className="w-full mb-4 p-2.5 bg-yellow-500/10 border border-yellow-500/30 rounded-xl flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
                <span className="text-xs text-yellow-300">Not connected. Set up a provider in settings.</span>
              </div>
            )}

            {/* Quick actions */}
            <div className="w-full grid grid-cols-2 gap-2">
              {QUICK_ACTIONS.map(action => (
                <button
                  key={action.label}
                  onClick={() => handleSend(action.label)}
                  className="flex items-center gap-2 p-3 bg-p01-surface rounded-xl hover:bg-p01-elevated transition-colors text-left"
                >
                  <action.icon className={`w-4 h-4 ${action.color} shrink-0`} />
                  <span className="text-xs text-white font-medium">{action.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Chat messages */
          <div className="p-4 space-y-3">
            {messages.map(msg => (
              <ChatBubble key={msg.id} message={msg} onSuggestionClick={handleSend} />
            ))}

            {/* Loading indicator */}
            {isLoading && !streamingMessage && (
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-p01-cyan rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-p01-cyan rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-p01-cyan rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl" role="alert" aria-live="polite">
                <X className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-red-300">{error}</p>
                  <button onClick={clearError} className="text-xs text-p01-chrome mt-1 hover:underline">Dismiss</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="p-3 border-t border-p01-border shrink-0">
        <div className="flex items-center gap-2 bg-p01-surface rounded-xl px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask P-01 Agent..."
            aria-label="Message"
            className="flex-1 bg-transparent text-sm text-white placeholder-p01-chrome/40 outline-none min-w-0"
            disabled={isLoading}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isLoading}
            aria-label="Send message"
            className={`p-1.5 rounded-lg transition-colors ${
              input.trim() && !isLoading
                ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
                : 'text-p01-chrome/30'
            }`}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  onSuggestionClick,
}: {
  message: DisplayMessage;
  onSuggestionClick: (text: string) => void;
}) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${isUser ? 'order-1' : ''}`}>
        <div
          className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? 'bg-p01-cyan text-p01-void rounded-br-md'
              : 'bg-p01-surface text-white rounded-bl-md'
          }`}
        >
          {message.content || (
            <span className="text-p01-chrome/50 italic text-xs">Thinking...</span>
          )}
        </div>

        {/* Suggestion chips */}
        {!isUser && message.suggestions && message.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.suggestions.map(suggestion => (
              <button
                key={suggestion}
                onClick={() => onSuggestionClick(suggestion)}
                className="px-2.5 py-1 bg-p01-surface/50 border border-p01-border rounded-full text-xs text-p01-chrome hover:bg-p01-surface hover:text-white transition-colors"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
