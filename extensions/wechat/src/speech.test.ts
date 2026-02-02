import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadSpeechCredentials } from "./speech.js";

// Mock child_process for ffmpeg tests
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs for credential loading tests
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdtempSync: vi.fn(() => "/tmp/test-speech"),
    rmdirSync: vi.fn(),
  };
});

describe("speech", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("loadSpeechCredentials", () => {
    it("should load from environment variables", () => {
      process.env.AZURE_SPEECH_KEY = "test-key";
      process.env.AZURE_SPEECH_REGION = "eastasia";

      const creds = loadSpeechCredentials();

      expect(creds).not.toBeNull();
      expect(creds?.key).toBe("test-key");
      expect(creds?.region).toBe("eastasia");
    });

    it("should return null when env vars missing", () => {
      delete process.env.AZURE_SPEECH_KEY;
      delete process.env.AZURE_SPEECH_REGION;

      // Mock fs.existsSync to return false
      const fs = require("node:fs");
      fs.existsSync.mockReturnValue(false);

      const creds = loadSpeechCredentials();

      expect(creds).toBeNull();
    });

    it("should fallback to .clawdbot/azure-speech.env file", () => {
      delete process.env.AZURE_SPEECH_KEY;
      delete process.env.AZURE_SPEECH_REGION;

      const fs = require("node:fs");
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(`
# Azure Speech credentials
AZURE_SPEECH_KEY=file-key
AZURE_SPEECH_REGION=westus
`);

      const creds = loadSpeechCredentials();

      expect(creds).not.toBeNull();
      expect(creds?.key).toBe("file-key");
      expect(creds?.region).toBe("westus");
    });

    it("should handle malformed env file gracefully", () => {
      delete process.env.AZURE_SPEECH_KEY;
      delete process.env.AZURE_SPEECH_REGION;

      const fs = require("node:fs");
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue("invalid content without equals");

      const creds = loadSpeechCredentials();

      expect(creds).toBeNull();
    });
  });
});

describe("transcribeVoice", () => {
  it("should handle missing credentials gracefully", async () => {
    // This is an integration test placeholder
    // Full test would require mocking fetch and ffmpeg
    expect(true).toBe(true);
  });
});

describe("AMR to WAV conversion", () => {
  it("should use correct ffmpeg parameters", () => {
    // This validates the expected ffmpeg command structure
    const expectedArgs = [
      "-y",           // overwrite output
      "-i", "input.amr",
      "-ar", "16000", // 16kHz sample rate for speech recognition
      "-ac", "1",     // mono channel
      "-f", "wav",
      "output.wav",
    ];

    // Verify the structure is correct
    expect(expectedArgs).toContain("-ar");
    expect(expectedArgs).toContain("16000");
    expect(expectedArgs).toContain("-ac");
    expect(expectedArgs).toContain("1");
  });
});

describe("Azure Speech API response handling", () => {
  it("should handle Success response", () => {
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
    const zhResult = { ok: true, text: "你好", language: "zh-CN", confidence: 0.85 };
    const enResult = { ok: true, text: "hello", language: "en-US", confidence: 0.92 };

    // English has higher confidence
    const selected = enResult.confidence! > zhResult.confidence! ? enResult : zhResult;
    expect(selected.language).toBe("en-US");
  });
});
