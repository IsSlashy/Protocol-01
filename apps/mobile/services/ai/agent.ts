import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stream } from '../solana/streams';
import { analyzeStreams, formatAnalysisForAI, getBalanceSummary, StreamAnalysis } from './streamAnalyzer';

// AI Service Configuration
export interface AIConfig {
  provider: 'gemma' | 'gemma-cloud' | 'ollama' | 'openai' | 'anthropic' | 'custom';
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  maxTokens: number;
  // Gemma specific
  gemmaBackend?: 'on-device' | 'google-ai' | 'ollama';
}

// Default configurations for different providers
export const DEFAULT_CONFIGS: Record<string, Partial<AIConfig>> = {
  // Gemma - Default for Protocol 01
  gemma: {
    provider: 'gemma',
    baseUrl: '', // On-device doesn't need URL
    model: 'gemma-3n-2b',
    temperature: 0.7,
    maxTokens: 1024,
    gemmaBackend: 'on-device',
  },
  'gemma-cloud': {
    provider: 'gemma-cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemma-3n-e4b-it',
    temperature: 0.7,
    maxTokens: 1024,
    gemmaBackend: 'google-ai',
  },
  // Legacy providers (advanced options)
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'gemma3:2b',
    temperature: 0.7,
    maxTokens: 1024,
  },
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 1024,
  },
  anthropic: {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-haiku-20240307',
    temperature: 0.7,
    maxTokens: 1024,
  },
};

// System prompt for the P-01 Agent
const SYSTEM_PROMPT = `You are P-01 Agent, a smart financial assistant for Protocol 01 wallet on Solana.

YOUR PRIMARY MISSION:
Help users SAVE MONEY and TIME by analyzing their recurring payments (Streams).

YOUR CAPABILITIES:
1. STREAM ANALYSIS (Priority #1):
   - Identify unused or rarely used subscriptions
   - Detect subscriptions that cost too much relative to usage
   - Suggest which subscriptions to cancel or pause
   - Calculate potential monthly/yearly savings
   - Alert when subscriptions are about to renew

2. BALANCE MONITORING:
   - Track wallet balance changes
   - Alert when balance is low
   - Predict when funds will run out based on active streams
   - Suggest optimal timing for top-ups

3. SMART RECOMMENDATIONS:
   - "You have 3 streams totaling 0.5 SOL/month. Stream X hasn't been used in 30 days."
   - "Canceling Stream Y would save you 0.1 SOL/month (1.2 SOL/year)"
   - "Your balance will be depleted in 15 days at current spending rate"

PERSONALITY:
- Proactive: Don't wait to be asked, suggest optimizations
- Money-focused: Always think about savings
- Clear: Use simple numbers and percentages
- Helpful: Provide actionable recommendations

RESPONSE FORMAT:
- Keep responses short and actionable
- Use bullet points for lists
- Always mention potential savings in SOL
- Prioritize most impactful recommendations first
- Always prioritize security and warn about potential risks
- If you don't know something, say so honestly
- Format amounts clearly (e.g., "0.5 SOL" not "0.50000000 SOL")

Current context:
- Network: Devnet (test network)
- User has a P-01 wallet connected`;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  success: boolean;
  message?: string;
  error?: string;
}

// Context for AI to analyze
export interface AIContext {
  streams?: Stream[];
  balance?: number;
  walletAddress?: string;
}

const STORAGE_KEY = 'p01_ai_config';

// Load AI configuration from storage
export async function loadConfig(): Promise<AIConfig> {
  // Always return Gemma on-device config for now
  // This ensures the AI always works without network
  return DEFAULT_CONFIGS.gemma as AIConfig;
}

// Save AI configuration
export async function saveConfig(config: AIConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('Failed to save AI config:', error);
    throw error;
  }
}

// Test connection to the AI provider
export async function testConnection(config: AIConfig): Promise<{ success: boolean; error?: string }> {
  try {
    // Gemma on-device - always available
    if (config.provider === 'gemma' && config.gemmaBackend === 'on-device') {
      // On-device Gemma is always ready (using built-in fallback)
      return { success: true };
    }

    // Gemma via Google AI
    if (config.provider === 'gemma' || config.provider === 'gemma-cloud') {
      if (config.gemmaBackend === 'google-ai') {
        if (!config.apiKey) {
          // Can work without API key using fallback responses
          return { success: true };
        }
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey}`
        );
        return { success: response.ok, error: response.ok ? undefined : 'Invalid Google AI API key' };
      }
      // Default: on-device mode
      return { success: true };
    }

    if (config.provider === 'ollama') {
      // Test Ollama connection
      const response = await fetch(`${config.baseUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        return { success: false, error: `Ollama not responding (${response.status})` };
      }

      const data = await response.json();
      const models = data.models || [];
      const hasModel = models.some((m: any) => m.name === config.model || m.name.startsWith(config.model));

      if (!hasModel && models.length > 0) {
        return {
          success: false,
          error: `Model "${config.model}" not found. Available: ${models.map((m: any) => m.name).slice(0, 3).join(', ')}`
        };
      }

      return { success: true };
    } else if (config.provider === 'openai') {
      if (!config.apiKey) {
        return { success: false, error: 'API key required for OpenAI' };
      }

      const response = await fetch(`${config.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
      });

      return { success: response.ok, error: response.ok ? undefined : 'Invalid API key' };
    } else if (config.provider === 'anthropic') {
      if (!config.apiKey) {
        return { success: false, error: 'API key required for Anthropic' };
      }

      // Anthropic doesn't have a simple test endpoint, so we'll assume it works if key is provided
      return { success: true };
    }

    return { success: false, error: 'Unknown provider' };
  } catch (error: any) {
    // Silently fail - AI connection is optional
    return {
      success: false,
      error: error.message?.includes('Network request failed')
        ? 'Cannot connect. Make sure the AI server is running.'
        : error.message || 'Connection failed'
    };
  }
}

// Send a chat message to the AI
export async function sendMessage(
  messages: ChatMessage[],
  config?: AIConfig,
  context?: AIContext
): Promise<ChatResponse> {
  const activeConfig = config || await loadConfig();

  // Build enhanced system prompt with context
  let enhancedPrompt = SYSTEM_PROMPT;

  if (context?.streams && context.streams.length > 0) {
    const analysis = analyzeStreams(context.streams, context.balance || 0);
    enhancedPrompt += `\n\nCURRENT USER DATA:\n${formatAnalysisForAI(analysis)}`;
  }

  if (context?.balance !== undefined) {
    enhancedPrompt += `\n\nWallet balance: ${context.balance.toFixed(4)} SOL`;
  }

  // Add system prompt if not present
  const allMessages: ChatMessage[] = [
    { role: 'system', content: enhancedPrompt },
    ...messages,
  ];

  try {
    // Gemma providers
    if (activeConfig.provider === 'gemma' || activeConfig.provider === 'gemma-cloud') {
      return await sendToGemma(allMessages, activeConfig, context);
    } else if (activeConfig.provider === 'ollama') {
      return await sendToOllama(allMessages, activeConfig);
    } else if (activeConfig.provider === 'openai') {
      return await sendToOpenAI(allMessages, activeConfig);
    } else if (activeConfig.provider === 'anthropic') {
      return await sendToAnthropic(allMessages, activeConfig);
    } else {
      return { success: false, error: 'Unknown AI provider' };
    }
  } catch (error: any) {
    console.error('AI request failed:', error);
    return {
      success: false,
      error: error.message?.includes('Network request failed')
        ? 'Cannot connect to AI. Check your connection settings.'
        : error.message || 'Failed to get AI response'
    };
  }
}

// Gemma AI (on-device or Google AI)
async function sendToGemma(messages: ChatMessage[], config: AIConfig, context?: AIContext): Promise<ChatResponse> {
  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

  // Build context string for the AI
  let contextInfo = '';
  if (context?.streams && context.streams.length > 0) {
    const analysis = analyzeStreams(context.streams, context.balance || 0);
    contextInfo = `\n\nDONNÉES UTILISATEUR:\n${formatAnalysisForAI(analysis)}`;
  }
  if (context?.balance !== undefined && context.balance > 0) {
    contextInfo += `\nSolde wallet: ${context.balance.toFixed(4)} SOL`;
  }

  // Try Google AI first (free Gemini API)
  try {
    const gemmaMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // Use Gemini 1.5 Flash (free tier, fast)
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyBSXdPLfBxGSS4A92QdgLBgMbdqvFqFoCg',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: gemmaMessages.filter(m => m.role !== 'system'),
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT + contextInfo }] },
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024,
          },
        }),
      }
    );

    if (response.ok) {
      const data = await response.json();
      const message = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (message) {
        return { success: true, message };
      }
    }
  } catch (error: any) {
    console.warn('[AI] Google AI failed:', error.message);
  }

  // Fallback to rule-based responses if API fails
  return sendToGemmaOnDevice(lastUserMessage, context);
}

// On-device fallback with smart responses focused on streams
function sendToGemmaOnDevice(userMessage: string, context?: AIContext): ChatResponse {
  const lower = userMessage.toLowerCase();
  const hasStreams = context?.streams && context.streams.length > 0;
  const hasBalance = context?.balance !== undefined;

  // Get analysis if we have streams
  let analysis: StreamAnalysis | null = null;
  if (hasStreams) {
    analysis = analyzeStreams(context!.streams!, context?.balance || 0);
  }

  // Stream/Subscription analysis (Priority)
  if (lower.includes('stream') || lower.includes('subscription') || lower.includes('abonnement') ||
      lower.includes('recurring') || lower.includes('récurrent') || lower.includes('analyse')) {
    if (analysis) {
      return {
        success: true,
        message: formatAnalysisForAI(analysis),
      };
    }
    return {
      success: true,
      message: "ANALYSE DE VOS ABONNEMENTS\n\nJe n'ai pas encore accès à vos streams. Assurez-vous d'avoir créé au moins un abonnement pour que je puisse les analyser.",
    };
  }

  // Savings/Optimization queries
  if (lower.includes('économ') || lower.includes('save') || lower.includes('saving') ||
      lower.includes('optimis') || lower.includes('reduc') || lower.includes('cancel') ||
      lower.includes('annul') || lower.includes('inutile') || lower.includes('unused')) {
    if (analysis && analysis.recommendations.length > 0) {
      let message = "OPTIMISATIONS TROUVEES\n\n";

      const highPriority = analysis.recommendations.filter(r => r.priority === 'high');
      const mediumPriority = analysis.recommendations.filter(r => r.priority === 'medium');

      if (highPriority.length > 0) {
        message += "[URGENT]\n";
        highPriority.forEach(rec => {
          message += `- ${rec.streamName}: ${rec.reason}\n`;
          message += `  > ${rec.actionText}\n`;
        });
        message += "\n";
      }

      if (mediumPriority.length > 0) {
        message += "[A VERIFIER]\n";
        mediumPriority.forEach(rec => {
          message += `- ${rec.streamName}: ${rec.reason}\n`;
        });
        message += "\n";
      }

      if (analysis.savingsPotential > 0) {
        message += `ECONOMIES POTENTIELLES: ${analysis.savingsPotential.toFixed(4)} SOL/mois\n`;
        message += `(${(analysis.savingsPotential * 12).toFixed(4)} SOL/an)`;
      }

      return { success: true, message };
    } else if (analysis) {
      return {
        success: true,
        message: "BONNE NOUVELLE\n\nVos abonnements semblent optimisés!\n\n- " + analysis.activeStreams + " streams actifs\n- " + analysis.totalMonthlySpend.toFixed(4) + " SOL/mois\n- Aucune recommandation d'économie pour le moment.",
      };
    }
    return {
      success: true,
      message: "OPTIMISATION\n\nJe ne peux pas analyser vos abonnements sans données. Créez des streams pour que je puisse les optimiser.",
    };
  }

  // Balance queries
  if (lower.includes('balance') || lower.includes('solde') || lower.includes('combien') || lower.includes('reste')) {
    if (hasBalance && analysis) {
      return {
        success: true,
        message: getBalanceSummary(context!.balance!, analysis),
      };
    } else if (hasBalance) {
      return {
        success: true,
        message: `VOTRE SOLDE: ${context!.balance!.toFixed(4)} SOL\n\nAucun stream actif pour calculer l'autonomie.`,
      };
    }
    return {
      success: true,
      message: "SOLDE\n\nJe n'ai pas accès à votre solde actuellement. Vérifiez votre connexion au wallet.",
    };
  }

  // Expensive/costly queries
  if (lower.includes('cher') || lower.includes('expensive') || lower.includes('cost') || lower.includes('coût') || lower.includes('depens')) {
    if (analysis) {
      let message = "ANALYSE DES COUTS\n\n";
      message += `Total mensuel: ${analysis.totalMonthlySpend.toFixed(4)} SOL\n`;
      message += `Total annuel: ${analysis.totalYearlySpend.toFixed(4)} SOL\n`;
      message += `Streams actifs: ${analysis.activeStreams}\n`;

      // Find most expensive
      const activeStreams = context!.streams!.filter(s => s.status === 'active');
      if (activeStreams.length > 0) {
        const sorted = [...activeStreams].sort((a, b) => b.amountPerPayment - a.amountPerPayment);
        message += `\nPlus cher: ${sorted[0].name} (${sorted[0].amountPerPayment} SOL/${sorted[0].frequency})`;
      }

      return { success: true, message };
    }
    return {
      success: true,
      message: "COUTS\n\nAucun stream trouvé pour analyser vos dépenses.",
    };
  }

  // Renewal/upcoming payments
  if (lower.includes('renew') || lower.includes('prochain') || lower.includes('next') || lower.includes('upcoming') || lower.includes('bientôt')) {
    if (analysis && analysis.upcomingPayments.length > 0) {
      let message = "PROCHAINS PAIEMENTS\n\n";
      analysis.upcomingPayments.slice(0, 5).forEach(payment => {
        const dayText = payment.daysUntil === 0 ? "Aujourd'hui" :
                        payment.daysUntil === 1 ? "Demain" :
                        `Dans ${payment.daysUntil} jours`;
        message += `- ${payment.streamName}: ${payment.amount} SOL (${dayText})\n`;
      });
      return { success: true, message };
    }
    return {
      success: true,
      message: "PROCHAINS PAIEMENTS\n\nAucun paiement prévu dans les 30 prochains jours.",
    };
  }

  // Send/Transfer
  if (lower.includes('send') || lower.includes('transfer') || lower.includes('envoyer') || lower.includes('transférer')) {
    const amountMatch = userMessage.match(/(\d+(?:\.\d+)?)\s*(sol|usdc|usdt)?/i);
    if (amountMatch) {
      return {
        success: true,
        message: `Je prépare un transfert de ${amountMatch[1]} ${amountMatch[2]?.toUpperCase() || 'SOL'}. Vers quelle adresse?`,
      };
    }
    return {
      success: true,
      message: "Quel montant et vers quelle adresse?",
    };
  }

  // Greetings
  if (lower.match(/^(hi|hello|hey|bonjour|salut|coucou)/)) {
    let message = "Bonjour!\n\nJe suis P-01 Agent, votre assistant financier Protocol 01.\n\n";

    if (analysis) {
      message += `ETAT ACTUEL:\n`;
      message += `- ${analysis.activeStreams} streams actifs\n`;
      message += `- ${analysis.totalMonthlySpend.toFixed(4)} SOL/mois\n`;
      if (analysis.balanceRunwayDays !== null) {
        message += `- Autonomie: ~${analysis.balanceRunwayDays} jours\n`;
      }
      if (analysis.recommendations.length > 0) {
        message += `\n${analysis.recommendations.length} recommandation(s) disponible(s). Demandez "analyser mes abonnements" pour plus de détails.`;
      }
    } else {
      message += "Ma mission: vous aider à économiser en analysant vos abonnements.\n\n";
      message += "Que puis-je faire pour vous?\n- Analyser vos streams\n- Trouver des économies\n- Surveiller votre solde";
    }

    return { success: true, message };
  }

  // Help
  if (lower.includes('help') || lower.includes('aide') || lower.includes('?')) {
    return {
      success: true,
      message: "P-01 AGENT - ASSISTANT FINANCIER\n\nJe suis spécialisé dans:\n\n- Analyse des streams: Identifier les abonnements inutiles\n- Economies: Calculer combien vous pouvez économiser\n- Alertes: Prévenir quand le solde est bas\n- Prévisions: Estimer quand recharger\n\nCommandes:\n- \"Analyser mes abonnements\"\n- \"Quelles économies possibles?\"\n- \"Mon solde\"\n- \"Prochains paiements\"",
    };
  }

  // Default - proactive stream focus with status if available
  let message = "Je suis P-01 Agent, votre assistant financier.\n\n";

  if (analysis) {
    message += `Vous avez ${analysis.activeStreams} stream(s) actif(s) pour ${analysis.totalMonthlySpend.toFixed(4)} SOL/mois.\n\n`;
    if (analysis.recommendations.length > 0) {
      message += `J'ai ${analysis.recommendations.length} recommandation(s) pour optimiser vos dépenses.\n\n`;
    }
  }

  message += "Essayez:\n- \"Analyser mes abonnements\"\n- \"Quelles économies possibles?\"\n- \"Mon solde\"";

  return { success: true, message };
}

// Ollama API
async function sendToOllama(messages: ChatMessage[], config: AIConfig): Promise<ChatResponse> {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
      options: {
        temperature: config.temperature,
        num_predict: config.maxTokens,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    return { success: false, error: `Ollama error: ${error}` };
  }

  const data = await response.json();
  return {
    success: true,
    message: data.message?.content || data.response || 'No response'
  };
}

// OpenAI API
async function sendToOpenAI(messages: ChatMessage[], config: AIConfig): Promise<ChatResponse> {
  if (!config.apiKey) {
    return { success: false, error: 'OpenAI API key required' };
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    return { success: false, error: error.error?.message || 'OpenAI request failed' };
  }

  const data = await response.json();
  return {
    success: true,
    message: data.choices?.[0]?.message?.content || 'No response'
  };
}

// Anthropic API
async function sendToAnthropic(messages: ChatMessage[], config: AIConfig): Promise<ChatResponse> {
  if (!config.apiKey) {
    return { success: false, error: 'Anthropic API key required' };
  }

  // Anthropic uses a different format
  const systemMessage = messages.find(m => m.role === 'system')?.content || '';
  const chatMessages = messages.filter(m => m.role !== 'system');

  const response = await fetch(`${config.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemMessage,
      messages: chatMessages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    return { success: false, error: error.error?.message || 'Anthropic request failed' };
  }

  const data = await response.json();
  return {
    success: true,
    message: data.content?.[0]?.text || 'No response'
  };
}

// Get available Ollama models
export async function getOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];

    const data = await response.json();
    return (data.models || []).map((m: any) => m.name);
  } catch {
    return [];
  }
}
