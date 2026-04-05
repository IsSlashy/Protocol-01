/**
 * On-device LLM Service using llama.rn
 * Downloads and runs Gemma 3 1B Q4_K_M GGUF locally.
 *
 * Download fix: HuggingFace redirects cause totalBytesExpectedToWrite = -1.
 * We resolve the final URL via HEAD + get Content-Length, with fallback progress.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { initLlama, releaseAllLlama, LlamaContext, TokenData } from 'llama.rn';
import { TurboModuleRegistry } from 'react-native';

/**
 * Check if llama.rn native module is compiled into this APK.
 * Bundle-injected APKs won't have it — needs full EAS build.
 */
function isNativeModuleAvailable(): boolean {
  try {
    const mod = TurboModuleRegistry.get('RNLlama');
    return mod !== null && mod !== undefined;
  } catch {
    return false;
  }
}

// Model config
const MODEL_FILENAME = 'gemma-3-1b-q4.gguf';
// unsloth repo — public, no auth required (bartowski is gated/401)
const MODEL_URL = 'https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf';
const MODEL_SIZE_MB = 769; // ~806MB actual
const MODEL_SIZE_BYTES = MODEL_SIZE_MB * 1024 * 1024;
const MAX_RETRIES = 3;
const STALL_TIMEOUT_MS = 30_000; // 30s stall detection

export type ModelStatus = 'not_downloaded' | 'downloading' | 'ready' | 'loading' | 'loaded' | 'error';

// Singleton state
let llamaContext: LlamaContext | null = null;
let currentStatus: ModelStatus = 'not_downloaded';
let downloadProgress = 0;
let loadProgress = 0;
let statusListeners: Array<(status: ModelStatus, progress?: number) => void> = [];
let activeDownloadResumable: FileSystem.DownloadResumable | null = null;
let downloadCancelled = false;

function getModelPath(): string {
  return `${FileSystem.documentDirectory}models/${MODEL_FILENAME}`;
}

function notifyListeners(status: ModelStatus, progress?: number) {
  currentStatus = status;
  statusListeners.forEach(fn => fn(status, progress));
}

export function onStatusChange(listener: (status: ModelStatus, progress?: number) => void): () => void {
  statusListeners.push(listener);
  return () => {
    statusListeners = statusListeners.filter(l => l !== listener);
  };
}

export function getModelStatus(): ModelStatus {
  return currentStatus;
}

export function getDownloadProgress(): number {
  return downloadProgress;
}

export function getLoadProgress(): number {
  return loadProgress;
}

/**
 * Check if model file exists on disk
 */
export async function isModelDownloaded(): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(getModelPath());
    if (info.exists && info.size && info.size > 100_000_000) {
      if (currentStatus === 'not_downloaded') {
        currentStatus = 'ready';
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// No HEAD request — HuggingFace doesn't resolve redirects properly on mobile fetch().
// We use ?download=true in the URL and fallback progress based on MODEL_SIZE_MB.

/**
 * Download the model from HuggingFace with:
 * - HEAD request to resolve redirects + get Content-Length
 * - Fallback progress when totalBytesExpectedToWrite = -1
 * - 30s stall timeout with auto-retry (3 attempts)
 * - Cancel support
 */
export async function downloadModel(
  onProgress?: (progress: number) => void
): Promise<void> {
  if (currentStatus === 'downloading') return;

  downloadCancelled = false;
  notifyListeners('downloading', 0);
  downloadProgress = 0;

  // Ensure models directory exists
  const modelsDir = `${FileSystem.documentDirectory}models/`;
  const dirInfo = await FileSystem.getInfoAsync(modelsDir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(modelsDir, { intermediates: true });
  }

  const modelPath = getModelPath();
  const expectedBytes = MODEL_SIZE_BYTES;

  let lastBytesWritten = 0;
  let lastProgressTime = Date.now();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (downloadCancelled) {
      notifyListeners('not_downloaded');
      return;
    }

    try {
      console.log(`[LlamaService] Download attempt ${attempt}/${MAX_RETRIES}`);

      // Stall detection timer
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let stallReject: ((err: Error) => void) | null = null;

      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          console.warn('[LlamaService] Download stalled for 30s');
          stallReject?.(new Error('Download stalled'));
        }, STALL_TIMEOUT_MS);
      };

      const downloadResumable = FileSystem.createDownloadResumable(
        MODEL_URL,
        modelPath,
        {},
        (event) => {
          const written = event.totalBytesWritten;
          const expected = event.totalBytesExpectedToWrite;

          // Compute progress — handle -1 case from HuggingFace redirects
          let progress: number;
          if (expected > 0) {
            progress = written / expected;
          } else {
            // Fallback: use known model size
            progress = Math.min(written / expectedBytes, 0.99);
          }

          const pct = Math.round(progress * 100);
          downloadProgress = pct;

          // Calculate speed
          const now = Date.now();
          const elapsed = (now - lastProgressTime) / 1000;
          if (elapsed > 0 && written > lastBytesWritten) {
            const speed = (written - lastBytesWritten) / elapsed / 1024 / 1024;
            if (pct % 10 === 0) {
              console.log(`[LlamaService] ${pct}% — ${speed.toFixed(1)} MB/s`);
            }
          }
          lastBytesWritten = written;
          lastProgressTime = now;

          onProgress?.(pct);
          notifyListeners('downloading', pct);

          // Reset stall timer on progress
          resetStallTimer();
        }
      );

      activeDownloadResumable = downloadResumable;
      resetStallTimer();

      const result = await new Promise<FileSystem.FileSystemDownloadResult | undefined>(
        (resolve, reject) => {
          stallReject = reject;
          downloadResumable.downloadAsync().then(resolve).catch(reject);
        }
      );

      // Clear stall timer
      if (stallTimer) clearTimeout(stallTimer);
      activeDownloadResumable = null;

      if (downloadCancelled) {
        try { await FileSystem.deleteAsync(modelPath, { idempotent: true }); } catch {}
        notifyListeners('not_downloaded');
        return;
      }

      if (result && result.uri) {
        // Verify file size
        const fileInfo = await FileSystem.getInfoAsync(modelPath);
        if (fileInfo.exists && fileInfo.size && fileInfo.size > 100_000_000) {
          downloadProgress = 100;
          notifyListeners('ready');
          onProgress?.(100);
          console.log(`[LlamaService] Download complete: ${(fileInfo.size / 1024 / 1024).toFixed(1)}MB`);
          return;
        } else {
          throw new Error('Downloaded file too small — likely corrupted');
        }
      } else {
        throw new Error('Download failed — no result');
      }
    } catch (error: any) {
      activeDownloadResumable = null;
      console.error(`[LlamaService] Download attempt ${attempt} failed:`, error.message);

      if (downloadCancelled) {
        try { await FileSystem.deleteAsync(modelPath, { idempotent: true }); } catch {}
        notifyListeners('not_downloaded');
        return;
      }

      if (attempt === MAX_RETRIES) {
        // Clean up partial download
        try { await FileSystem.deleteAsync(modelPath, { idempotent: true }); } catch {}
        notifyListeners('error');
        throw error;
      }

      // Wait before retry
      console.log(`[LlamaService] Retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

/**
 * Cancel an in-progress download
 */
export async function cancelDownload(): Promise<void> {
  downloadCancelled = true;
  if (activeDownloadResumable) {
    try {
      await activeDownloadResumable.pauseAsync();
    } catch {}
    activeDownloadResumable = null;
  }
  // Clean up partial file
  try {
    await FileSystem.deleteAsync(getModelPath(), { idempotent: true });
  } catch {}
  downloadProgress = 0;
  notifyListeners('not_downloaded');
}

/**
 * Delete the downloaded model to free storage
 */
export async function deleteModel(): Promise<void> {
  await releaseModel();
  const modelPath = getModelPath();
  try {
    await FileSystem.deleteAsync(modelPath, { idempotent: true });
  } catch {}
  downloadProgress = 0;
  notifyListeners('not_downloaded');
}

/**
 * Get the model file size on disk (in MB)
 */
export async function getModelSizeMB(): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(getModelPath());
    if (info.exists && info.size) {
      return Math.round(info.size / (1024 * 1024));
    }
  } catch {}
  return 0;
}

/**
 * Load the model into memory and create a LlamaContext
 */
export async function initModel(
  onProgress?: (progress: number) => void
): Promise<LlamaContext> {
  if (llamaContext) return llamaContext;

  // Check if native module exists (not available in bundle-injected APKs)
  if (!isNativeModuleAvailable()) {
    throw new Error(
      'On-device inference requires a native build (EAS). Use Groq or Gemini cloud provider instead.'
    );
  }

  const downloaded = await isModelDownloaded();
  if (!downloaded) {
    throw new Error('Model not downloaded. Call downloadModel() first.');
  }

  notifyListeners('loading', 0);
  loadProgress = 0;

  try {
    const modelPath = getModelPath();

    llamaContext = await initLlama(
      {
        model: modelPath,
        n_ctx: 4096,
        n_gpu_layers: 99,
        use_mlock: true,
        flash_attn_type: 'auto',
      },
      (progress) => {
        loadProgress = Math.round(progress);
        onProgress?.(loadProgress);
        notifyListeners('loading', loadProgress);
      }
    );

    notifyListeners('loaded');
    console.log('[LlamaService] Model loaded. GPU:', llamaContext.gpu);
    return llamaContext;
  } catch (error: any) {
    console.error('[LlamaService] Init failed:', error);
    llamaContext = null;
    notifyListeners('error');
    throw error;
  }
}

/**
 * Check if the model is currently loaded in memory
 */
export function isModelLoaded(): boolean {
  return llamaContext !== null;
}

/**
 * Chat completion with streaming tokens
 */
export async function chat(
  messages: Array<{ role: string; content: string }>,
  onToken?: (token: string) => void,
  options?: {
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
  }
): Promise<string> {
  if (!llamaContext) {
    throw new Error('Model not loaded. Call initModel() first.');
  }

  const result = await llamaContext.completion(
    {
      messages,
      n_predict: options?.maxTokens || 512,
      temperature: options?.temperature || 0.7,
      stop: options?.stop || ['<end_of_turn>', '<eos>'],
      top_p: 0.9,
      top_k: 40,
    },
    onToken
      ? (data: TokenData) => {
          if (data.token) {
            onToken(data.token);
          }
        }
      : undefined
  );

  return result.text;
}

/**
 * Stop an in-progress completion
 */
export async function stopCompletion(): Promise<void> {
  if (llamaContext) {
    await llamaContext.stopCompletion();
  }
}

/**
 * Release the model from memory
 */
export async function releaseModel(): Promise<void> {
  if (llamaContext) {
    try {
      await llamaContext.release();
    } catch (error) {
      console.warn('[LlamaService] Release error:', error);
    }
    llamaContext = null;
  }
  if (currentStatus === 'loaded' || currentStatus === 'loading') {
    notifyListeners('ready');
  }
}

/**
 * Release all llama contexts (cleanup)
 */
export async function releaseAll(): Promise<void> {
  try {
    await releaseAllLlama();
  } catch {}
  llamaContext = null;
  if (currentStatus === 'loaded' || currentStatus === 'loading') {
    notifyListeners('ready');
  }
}

/**
 * Get approximate RAM usage when model is loaded
 */
export function getEstimatedRamMB(): number {
  return MODEL_SIZE_MB; // Q4_K_M roughly uses ~same as file size in RAM
}

/**
 * Check if on-device inference is available (native module compiled in)
 */
export function isOnDeviceAvailable(): boolean {
  return isNativeModuleAvailable();
}

// ── KV Cache Pre-warming ─────────────────────────────────────────────────────
// Pre-process the system prompt + conversation history into the KV cache
// while the user types. When they send, only the new tokens need prefill.
// llama.cpp automatically reuses matching prefix tokens in the KV cache.

let warmupAbortController: AbortController | null = null;
let lastWarmupPrompt: string = '';

/**
 * Pre-warm the KV cache with the system prompt + conversation history.
 * Call this when the user starts typing (debounced ~500ms).
 * The next completion() call with the same prefix will skip prefill.
 */
export async function warmupCache(
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  if (!llamaContext) return;

  // Build the prompt that would be used for the next completion
  const warmupMessages = [...messages];

  // Abort any previous warmup
  if (warmupAbortController) {
    warmupAbortController.abort();
  }
  warmupAbortController = new AbortController();

  try {
    // Run completion with n_predict=0 — this fills the KV cache
    // with all input tokens without generating any output
    await llamaContext.completion({
      messages: warmupMessages,
      n_predict: 0,
      temperature: 0.7,
    });
    lastWarmupPrompt = JSON.stringify(warmupMessages);
    console.log('[LlamaService] KV cache warmed:', warmupMessages.length, 'messages');
  } catch (error: any) {
    // Warmup is best-effort — don't fail
    if (error.message !== 'aborted') {
      console.warn('[LlamaService] Warmup failed:', error.message);
    }
  }
}

/**
 * Check if the KV cache is already warm for the given messages
 */
export function isCacheWarm(
  messages: Array<{ role: string; content: string }>,
): boolean {
  return lastWarmupPrompt === JSON.stringify(messages);
}

/**
 * Cancel any in-progress warmup (call when user sends message)
 */
export function cancelWarmup(): void {
  if (warmupAbortController) {
    warmupAbortController.abort();
    warmupAbortController = null;
  }
}

export const MODEL_INFO = {
  name: 'Gemma 3 1B',
  quantization: 'Q4_K_M',
  parameterCount: '1B',
  fileSizeMB: MODEL_SIZE_MB,
  contextLength: 2048,
};
