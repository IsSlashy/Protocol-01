import AsyncStorage from '@react-native-async-storage/async-storage';

// AI Service Configuration
export interface AIConfig {
  provider: 'ollama' | 'openai' | 'anthropic' | 'custom';
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  maxTokens: number;
}

// Default configurations for different providers
export const DEFAULT_CONFIGS: Record<string, Partial<AIConfig>> = {
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
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
const SYSTEM_PROMPT = `You are P-01 Agent, a helpful AI assistant for the Protocol 01 mobile wallet on Solana.

Your capabilities:
- Help users understand their wallet balance and transactions
- Guide users through sending SOL and tokens
- Explain how to swap tokens
- Provide information about Solana blockchain
- Help with privacy features of Protocol 01

Important guidelines:
- Be concise and helpful
- When users want to perform actions (send, swap, etc.), confirm the details before proceeding
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

const STORAGE_KEY = 'p01_ai_config';

// Load AI configuration from storage
export async function loadConfig(): Promise<AIConfig> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Failed to load AI config:', error);
  }

  // Default to Ollama
  return DEFAULT_CONFIGS.ollama as AIConfig;
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
  config?: AIConfig
): Promise<ChatResponse> {
  const activeConfig = config || await loadConfig();

  // Add system prompt if not present
  const allMessages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages,
  ];

  try {
    if (activeConfig.provider === 'ollama') {
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
