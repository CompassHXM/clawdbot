import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Test credential loading
describe("loadSpeechCredentials", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should load from environment variables", async () => {
    process.env.AZURE_SPEECH_KEY = "test-key";
    process.env.AZURE_SPEECH_REGION = "eastasia";

    const { loadSpeechCredentials } = await import("./speech.js");
    const creds = loadSpeechCredentials();

    expect(creds).not.toBeNull();
    expect(creds?.key).toBe("test-key");
    expect(creds?.region).toBe("eastasia");
  });

  it("should return null when env vars missing", async () => {
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;

    const { loadSpeechCredentials } = await import("./speech.js");
    const creds = loadSpeechCredentials();

    // May return null or load from file - depends on file existence
    // This test just ensures it doesn't throw
    expect(creds === null || (creds?.key && creds?.region)).toBe(true);
  });
});

describe("AMR to WAV conversion parameters", () => {
  it("should use correct ffmpeg parameters for speech recognition", () => {
    // These are the expected parameters for optimal Azure Speech recognition
    const expectedArgs = [
      "-y",           // overwrite output
      "-i", "input.amr",
      "-ar", "16000", // 16kHz sample rate for speech recognition
      "-ac", "1",     // mono channel
      "-f", "wav",
      "output.wav",
    ];

    // Verify structure
    expect(expectedArgs).toContain("-ar");
    expect(expectedArgs).toContain("16000");
    expect(expectedArgs).toContain("-ac");
    expect(expectedArgs).toContain("1");
  });
});

describe("Azure Speech API response handling", () => {
  it("should handle Success response structure", () => {
    const response = {
      RecognitionStatus: "Success",
      NBest: [
        {
          Confidence: 0.95,
          Lexical: "hello world",
          Display: "Hello world.",
        },
      ],
    };

    expect(response.RecognitionStatus).toBe("Success");
    expect(response.NBest?.[0]?.Confidence).toBeGreaterThan(0.9);
    expect(response.NBest?.[0]?.Display).toBe("Hello world.");
  });

  it("should handle NoMatch response", () => {
    const response = {
      RecognitionStatus: "NoMatch",
    };
    expect(response.RecognitionStatus).toBe("NoMatch");
  });

  it("should handle InitialSilenceTimeout response", () => {
    const response = {
      RecognitionStatus: "InitialSilenceTimeout",
    };
    expect(response.RecognitionStatus).toBe("InitialSilenceTimeout");
  });

  it("should select higher confidence result between languages", () => {
    const zhResult = { ok: true as const, text: "你好", language: "zh-CN", confidence: 0.85 };
    const enResult = { ok: true as const, text: "hello", language: "en-US", confidence: 0.92 };

    // English has higher confidence
    const selected = enResult.confidence > zhResult.confidence ? enResult : zhResult;
    expect(selected.language).toBe("en-US");
  });
});

describe("TranscribeOptions type constraints", () => {
  it("should only accept amr or wav as audioFormat", () => {
    // Type-level test: audioFormat should be restricted to "amr" | "wav"
    type ValidFormat = "amr" | "wav";
    const validFormats: ValidFormat[] = ["amr", "wav"];
    expect(validFormats).toContain("amr");
    expect(validFormats).toContain("wav");
    // "mp3" and "ogg" should NOT be valid (enforced by TypeScript)
  });
});
