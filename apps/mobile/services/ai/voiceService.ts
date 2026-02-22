/**
 * Voice input service: Recording + Groq Whisper transcription.
 *
 * NOTE: expo-av is NOT imported here. It requires a native rebuild (EAS build).
 * Until the next EAS build, voice recording is stubbed out.
 * After EAS build, uncomment the expo-av lines below and remove the stubs.
 */

import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_RECORDING_MS = 60_000;
const WHISPER_MODEL = 'whisper-large-v3';

let recordingStartTime = 0;
let _isRecording = false;

/**
 * Check if voice recording is available.
 * Returns false until a native build with expo-av is installed.
 */
export async function isAvailable(): Promise<boolean> {
  // expo-av not in this APK — will be available after EAS build
  return false;
}

/**
 * Request microphone permissions
 */
export async function requestPermissions(): Promise<boolean> {
  console.warn('[Voice] expo-av not available — needs native build');
  return false;
}

/**
 * Start recording audio
 */
export async function startRecording(): Promise<boolean> {
  const available = await isAvailable();
  if (!available) {
    console.warn('[Voice] Voice recording requires a native build with expo-av');
    return false;
  }
  return false;
}

/**
 * Stop recording and return the file URI
 */
export async function stopRecording(): Promise<string | null> {
  return null;
}

/**
 * Cancel recording and discard
 */
export async function cancelRecording(): Promise<void> {
  _isRecording = false;
}

/**
 * Get recording duration in seconds
 */
export function getRecordingDuration(): number {
  if (!recordingStartTime || !_isRecording) return 0;
  return Math.floor((Date.now() - recordingStartTime) / 1000);
}

/**
 * Check if currently recording
 */
export function isCurrentlyRecording(): boolean {
  return _isRecording;
}

/**
 * Transcribe audio file using Groq Whisper API
 */
export async function transcribe(
  fileUri: string,
  groqApiKey: string
): Promise<string> {
  if (!groqApiKey) {
    throw new Error('Groq API key required for voice transcription');
  }

  console.log('[Voice] Transcribing with Groq Whisper...');

  const fileInfo = await FileSystem.getInfoAsync(fileUri);
  if (!fileInfo.exists) {
    throw new Error('Recording file not found');
  }

  const result = await FileSystem.uploadAsync(GROQ_WHISPER_URL, fileUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    headers: {
      'Authorization': `Bearer ${groqApiKey}`,
    },
    parameters: {
      model: WHISPER_MODEL,
      language: 'en',
      response_format: 'json',
    },
  });

  try { await FileSystem.deleteAsync(fileUri, { idempotent: true }); } catch {}

  if (result.status !== 200) {
    console.error('[Voice] Transcription failed:', result.body);
    throw new Error(`Transcription failed (${result.status})`);
  }

  const data = JSON.parse(result.body);
  const text = data.text?.trim() || '';
  console.log(`[Voice] Transcribed: "${text.substring(0, 50)}..."`);
  return text;
}
