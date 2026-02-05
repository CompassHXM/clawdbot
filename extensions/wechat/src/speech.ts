/**
 * Azure Speech Service integration for voice-to-text transcription.
 *
 * This module provides speech-to-text functionality using Azure Cognitive Services.
 * It supports automatic language identification for Chinese and English.
 */

// We use the REST API instead of the SDK to avoid adding a heavy dependency.
// The SDK is ~50MB and requires native bindings that can cause issues.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TranscriptionResult = {
  ok: true;
  text: string;
  language: string;
  confidence?: number;
};

export type TranscriptionError = {
  ok: false;
  error: string;
};

export type TranscribeOptions = {
  /** Azure Speech Service subscription key */
  speechKey: string;
  /** Azure region (e.g., "eastasia") */
  speechRegion: string;
  /** Audio data as Buffer */
  audioBuffer: Buffer;
  /**
   * Audio format. Default: "amr"
   * - "amr": WeChat voice format, converted to WAV internally
   * - "wav": PCM WAV format, sent directly to Azure
   */
  audioFormat?: "amr" | "wav";
  /** Candidate languages for auto-detection (default: ["zh-CN", "en-US"]) */
  candidateLanguages?: string[];
};

/**
 * Transcribe audio to text using Azure Speech Service REST API.
 *
 * Uses the simple recognition endpoint which supports:
 * - Single utterance recognition (up to 60 seconds)
 * - Automatic language identification
 */
export async function transcribeVoice(
  options: TranscribeOptions,
): Promise<TranscriptionResult | TranscriptionError> {
  const {
    speechKey,
    speechRegion,
    audioBuffer,
    audioFormat = "amr",
    candidateLanguages = ["zh-CN", "en-US"],
  } = options;

  // For language identification, we need to use the SDK or a more complex flow.
  // The simple REST API doesn't support auto language detection directly.
  // So we'll try Chinese first (more common for WeChat), then fall back to English.

  // Try with Chinese first
  const zhResult = await recognizeSpeech({
    speechKey,
    speechRegion,
    audioBuffer,
    audioFormat,
    language: "zh-CN",
  });

  if (zhResult.ok && zhResult.text && zhResult.confidence && zhResult.confidence > 0.7) {
    return zhResult;
  }

  // If Chinese confidence is low, try English
  if (candidateLanguages.includes("en-US")) {
    const enResult = await recognizeSpeech({
      speechKey,
      speechRegion,
      audioBuffer,
      audioFormat,
      language: "en-US",
    });

    // Return whichever has higher confidence
    if (enResult.ok && zhResult.ok) {
      const zhConf = zhResult.confidence ?? 0;
      const enConf = enResult.confidence ?? 0;
      return enConf > zhConf ? enResult : zhResult;
    }

    if (enResult.ok) return enResult;
  }

  // Return Chinese result if we got something
  if (zhResult.ok && zhResult.text) {
    return zhResult;
  }

  return zhResult; // Return error if both failed
}

type RecognizeOptions = {
  speechKey: string;
  speechRegion: string;
  audioBuffer: Buffer;
  audioFormat: string;
  language: string;
};

async function recognizeSpeech(
  options: RecognizeOptions,
): Promise<TranscriptionResult | TranscriptionError> {
  const { speechKey, speechRegion, audioFormat, language } = options;
  let { audioBuffer } = options;

  // Azure Speech REST API requires WAV format for best compatibility.
  // AMR (used by WeChat) needs to be converted first.
  if (audioFormat === "amr") {
    const convertResult = convertAmrToWav(audioBuffer);
    if (!convertResult.ok) {
      return { ok: false, error: convertResult.error };
    }
    audioBuffer = convertResult.wavBuffer;
  }

  // For WAV, use audio/wav; Azure Speech supports PCM WAV natively
  const contentType = "audio/wav";

  // Azure Speech REST API endpoint for speech recognition
  // https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
  const endpoint = `https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;

  const url = new URL(endpoint);
  url.searchParams.set("language", language);
  url.searchParams.set("format", "detailed"); // Get confidence scores

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": speechKey,
        "Content-Type": contentType,
        Accept: "application/json",
      },
      body: new Uint8Array(audioBuffer),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        error: `Azure Speech API error: ${response.status} ${response.statusText} - ${errorText}`,
      };
    }

    const result = (await response.json()) as AzureSpeechResponse;

    if (result.RecognitionStatus === "Success" && result.NBest && result.NBest.length > 0) {
      const best = result.NBest[0];
      return {
        ok: true,
        text: best.Display || best.Lexical || "",
        language,
        confidence: best.Confidence,
      };
    }

    if (result.RecognitionStatus === "NoMatch") {
      return {
        ok: false,
        error: "No speech detected in audio",
      };
    }

    if (result.RecognitionStatus === "InitialSilenceTimeout") {
      return {
        ok: false,
        error: "Audio contains only silence",
      };
    }

    return {
      ok: false,
      error: `Recognition failed: ${result.RecognitionStatus}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Speech recognition request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Azure Speech API response types
type AzureSpeechResponse = {
  RecognitionStatus: "Success" | "NoMatch" | "InitialSilenceTimeout" | "BabbleTimeout" | "Error";
  Offset?: number;
  Duration?: number;
  NBest?: Array<{
    Confidence: number;
    Lexical: string;
    ITN: string;
    MaskedITN: string;
    Display: string;
  }>;
  DisplayText?: string;
};

/**
 * Load Azure Speech credentials from environment or config.
 */
export function loadSpeechCredentials(): { key: string; region: string } | null {
  // Try environment variables first
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (key && region) {
    return { key, region };
  }

  // Try loading from ~/.openclaw/azure-speech.env
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");

    const envPath = path.join(os.homedir(), ".openclaw", "azure-speech.env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      const lines = content.split("\n");
      let envKey: string | undefined;
      let envRegion: string | undefined;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;

        const [name, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=").trim();

        if (name === "AZURE_SPEECH_KEY") envKey = value;
        if (name === "AZURE_SPEECH_REGION") envRegion = value;
      }

      if (envKey && envRegion) {
        return { key: envKey, region: envRegion };
      }
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Convert AMR audio to WAV format using ffmpeg.
 * Azure Speech REST API works best with WAV (PCM) audio.
 */
function convertAmrToWav(
  amrBuffer: Buffer,
): { ok: true; wavBuffer: Buffer } | { ok: false; error: string } {
  let tempDir: string | null = null;
  try {
    // Create temp directory for conversion
    tempDir = mkdtempSync(join(tmpdir(), "speech-"));
    const amrPath = join(tempDir, "input.amr");
    const wavPath = join(tempDir, "output.wav");

    // Write AMR data to temp file
    writeFileSync(amrPath, amrBuffer);

    // Convert using ffmpeg
    // -ar 16000: 16kHz sample rate (optimal for speech recognition)
    // -ac 1: mono channel
    // -f wav: output format
    execFileSync(
      "ffmpeg",
      [
        "-y", // overwrite output
        "-i",
        amrPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        wavPath,
      ],
      {
        timeout: 10000, // 10 second timeout
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Read converted WAV
    const wavBuffer = readFileSync(wavPath);

    // Cleanup
    try {
      unlinkSync(amrPath);
      unlinkSync(wavPath);
    } catch {
      // Ignore cleanup errors
    }

    return { ok: true, wavBuffer };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `AMR to WAV conversion failed: ${message}` };
  } finally {
    // Try to remove temp dir
    if (tempDir) {
      try {
        const { rmdirSync } = require("node:fs");
        rmdirSync(tempDir);
      } catch {
        // Ignore
      }
    }
  }
}
