/**
 * Voice input service: Recording + Groq Whisper transcription.
 *
 * Migrated from deprecated expo-av to expo-audio (Expo 54+).
 * Uses the imperative createAudioRecorder API for service-layer usage.
 */

import {
  AudioModule,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  IOSOutputFormat,
  AudioQuality,
  type AudioRecorder,
} from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_RECORDING_MS = 60_000;
const WHISPER_MODEL = 'whisper-large-v3';

/** Recording preset tuned for voice: mono 16kHz AAC .m4a */
const VOICE_RECORDING_OPTIONS = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 64000,
  android: {
    outputFormat: 'mpeg4' as const,
    audioEncoder: 'aac' as const,
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.HIGH,
  },
};

let recorder: AudioRecorder | null = null;
let recordingStartTime = 0;
let _isRecording = false;
let _autoStopTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Check if voice recording is available.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    await getRecordingPermissionsAsync();
    return true; // Module exists, permissions may or may not be granted
  } catch {
    return false;
  }
}

/**
 * Request microphone permissions
 */
export async function requestPermissions(): Promise<boolean> {
  try {
    const { granted } = await requestRecordingPermissionsAsync();
    return granted;
  } catch (err) {
    console.warn('[Voice] Permission request failed:', err);
    return false;
  }
}

/**
 * Start recording audio
 */
export async function startRecording(): Promise<boolean> {
  try {
    // Request permissions if needed
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      console.warn('[Voice] Microphone permission denied');
      return false;
    }

    // Configure audio session
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    });

    // Stop any existing recording
    if (recorder) {
      try { await recorder.stop(); recorder.release(); } catch {}
      recorder = null;
    }

    // Create and start new recording
    recorder = new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS);
    await recorder.prepareToRecordAsync();
    recorder.record();

    recordingStartTime = Date.now();
    _isRecording = true;

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    // Auto-stop after max duration
    _autoStopTimer = setTimeout(async () => {
      if (_isRecording && recorder) {
        await stopRecording();
      }
    }, MAX_RECORDING_MS);

    console.log('[Voice] Recording started');
    return true;
  } catch (err) {
    console.error('[Voice] Failed to start recording:', err);
    _isRecording = false;
    recorder = null;
    return false;
  }
}

/**
 * Stop recording and return the file URI
 */
export async function stopRecording(): Promise<string | null> {
  if (!recorder) return null;

  try {
    _isRecording = false;
    if (_autoStopTimer) {
      clearTimeout(_autoStopTimer);
      _autoStopTimer = null;
    }

    await recorder.stop();

    // Reset audio mode
    await setAudioModeAsync({
      allowsRecording: false,
    });

    const uri = recorder.uri;
    recorder.release();
    recorder = null;

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    console.log('[Voice] Recording stopped, URI:', uri);
    return uri;
  } catch (err) {
    console.error('[Voice] Failed to stop recording:', err);
    if (recorder) {
      try { recorder.release(); } catch {}
    }
    recorder = null;
    _isRecording = false;
    return null;
  }
}

/**
 * Cancel recording and discard
 */
export async function cancelRecording(): Promise<void> {
  _isRecording = false;
  if (_autoStopTimer) {
    clearTimeout(_autoStopTimer);
    _autoStopTimer = null;
  }
  if (recorder) {
    try { await recorder.stop(); recorder.release(); } catch {}
    recorder = null;
  }
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
