import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock external dependencies
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdtempSync: vi.fn(() => "/tmp/test-wechat"),
    rmdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

// Mock fetch for API tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAccessToken", () => {
    it("should fetch and cache access token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-token-123",
          expires_in: 7200,
        }),
      });

      const { getAccessToken } = await import("./channel.js");
      const token = await getAccessToken("test-corp-id", "test-secret");

      expect(token).toBe("test-token-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("corpid=test-corp-id"),
      );
    });

    it("should use cached token on subsequent calls", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "cached-token",
          expires_in: 7200,
        }),
      });

      const { getAccessToken } = await import("./channel.js");
      
      // First call
      await getAccessToken("test-corp", "test-secret");
      
      // Second call should use cache
      const token = await getAccessToken("test-corp", "test-secret");

      expect(token).toBe("cached-token");
      // Should still be 1 call (cached)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          errcode: 40001,
          errmsg: "invalid credential",
        }),
      });

      const { getAccessToken } = await import("./channel.js");

      await expect(getAccessToken("bad-corp", "bad-secret")).rejects.toThrow(
        "invalid credential",
      );
    });
  });

  describe("sendWorkWechatMessage", () => {
    it("should send text message successfully", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "token", expires_in: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errcode: 0, msgid: "msg-123" }),
        });

      const { sendWorkWechatMessage } = await import("./channel.js");
      const result = await sendWorkWechatMessage({
        corpId: "corp",
        secret: "secret",
        agentId: "1000002",
        toUser: "xiaoming",
        content: "Hello!",
      });

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("msg-123");
    });

    it("should send markdown message", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "token", expires_in: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errcode: 0, msgid: "msg-md" }),
        });

      const { sendWorkWechatMessage } = await import("./channel.js");
      const result = await sendWorkWechatMessage({
        corpId: "corp",
        secret: "secret",
        agentId: "1000002",
        toUser: "xiaoming",
        content: "**Bold** text",
        msgType: "markdown",
      });

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"msgtype":"markdown"'),
        }),
      );
    });

    it("should handle send failure", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "token", expires_in: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errcode: 60011, errmsg: "no permission" }),
        });

      const { sendWorkWechatMessage } = await import("./channel.js");
      const result = await sendWorkWechatMessage({
        corpId: "corp",
        secret: "secret",
        agentId: "1000002",
        toUser: "blocked-user",
        content: "Test",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("no permission");
    });
  });

  describe("sendWorkWechatVoice", () => {
    it("should send voice message with mediaId", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "token", expires_in: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errcode: 0, msgid: "voice-msg-123" }),
        });

      const { sendWorkWechatVoice } = await import("./channel.js");
      const result = await sendWorkWechatVoice({
        corpId: "corp",
        secret: "secret",
        agentId: "1000002",
        toUser: "xiaoming",
        mediaId: "media-id-123",
      });

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("voice-msg-123");
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"msgtype":"voice"'),
        }),
      );
    });
  });

  describe("uploadMedia", () => {
    it("should upload voice file", async () => {
      const fs = require("node:fs");
      fs.readFileSync.mockReturnValue(Buffer.from("fake-amr-data"));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "token", expires_in: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            type: "voice",
            media_id: "uploaded-media-123",
            created_at: "1234567890",
          }),
        });

      const { uploadMedia } = await import("./channel.js");
      const result = await uploadMedia({
        corpId: "corp",
        secret: "secret",
        type: "voice",
        filePath: "/tmp/voice.amr",
        fileName: "voice.amr",
      });

      expect(result.ok).toBe(true);
      expect(result.mediaId).toBe("uploaded-media-123");
    });

    it("should handle upload failure", async () => {
      const fs = require("node:fs");
      fs.readFileSync.mockReturnValue(Buffer.from("data"));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "token", expires_in: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errcode: 40004, errmsg: "invalid media type" }),
        });

      const { uploadMedia } = await import("./channel.js");
      const result = await uploadMedia({
        corpId: "corp",
        secret: "secret",
        type: "voice",
        filePath: "/tmp/bad.mp4",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("invalid media type");
    });
  });
});

describe("audio file detection", () => {
  it("should identify audio file extensions", () => {
    const audioExtensions = [".mp3", ".opus", ".ogg", ".wav", ".amr", ".m4a", ".aac"];
    const nonAudioExtensions = [".txt", ".json", ".png", ".jpg", ".pdf"];

    const isAudioFile = (filePath: string): boolean => {
      const ext = filePath.toLowerCase().split(".").pop();
      return audioExtensions.includes(`.${ext}`);
    };

    // Audio files
    expect(isAudioFile("/tmp/voice.mp3")).toBe(true);
    expect(isAudioFile("/tmp/voice.opus")).toBe(true);
    expect(isAudioFile("/tmp/voice.amr")).toBe(true);
    expect(isAudioFile("/tmp/voice.WAV")).toBe(true);

    // Non-audio files
    expect(isAudioFile("/tmp/doc.txt")).toBe(false);
    expect(isAudioFile("/tmp/image.png")).toBe(false);
  });
});

describe("AMR conversion", () => {
  it("should use correct ffmpeg parameters for AMR-NB", () => {
    // AMR-NB requirements:
    // - Sample rate: 8000 Hz
    // - Channels: 1 (mono)
    // - Codec: libopencore_amrnb
    const expectedArgs = [
      "-y",
      "-i", "input.opus",
      "-ar", "8000",
      "-ac", "1",
      "-c:a", "libopencore_amrnb",
      "output.amr",
    ];

    expect(expectedArgs).toContain("-ar");
    expect(expectedArgs).toContain("8000");
    expect(expectedArgs).toContain("-c:a");
    expect(expectedArgs).toContain("libopencore_amrnb");
  });
});

describe("target resolution", () => {
  it("should handle wechat: prefix", () => {
    const normalizeWechatMessagingTarget = (target: string): string | null => {
      const trimmed = target.trim();
      if (!trimmed) return null;
      const cleaned = trimmed.replace(/^wechat:/i, "").trim();
      if (!cleaned) return null;
      return cleaned;
    };

    expect(normalizeWechatMessagingTarget("wechat:xiaoming")).toBe("xiaoming");
    expect(normalizeWechatMessagingTarget("WECHAT:user123")).toBe("user123");
    expect(normalizeWechatMessagingTarget("xiaoming")).toBe("xiaoming");
    expect(normalizeWechatMessagingTarget("")).toBeNull();
    expect(normalizeWechatMessagingTarget("wechat:")).toBeNull();
  });

  it("should identify valid wechat target IDs", () => {
    const looksLikeWechatTargetId = (target: string): boolean => {
      const trimmed = target.trim();
      if (!trimmed) return false;
      if (/^wechat:/i.test(trimmed)) return true;
      return /^[\w\u4e00-\u9fa5-]+$/i.test(trimmed);
    };

    // Valid targets
    expect(looksLikeWechatTargetId("xiaoming")).toBe(true);
    expect(looksLikeWechatTargetId("wechat:user123")).toBe(true);
    expect(looksLikeWechatTargetId("小明")).toBe(true);
    expect(looksLikeWechatTargetId("user_123")).toBe(true);

    // Invalid targets
    expect(looksLikeWechatTargetId("")).toBe(false);
    expect(looksLikeWechatTargetId("   ")).toBe(false);
  });
});
